/* Corporate Actions V1 — cross-provider audit.
 *
 *   npx tsx scripts/market/compare-ca.mts
 *
 * Reads ONLY — produces bench/corporate-actions-v1-audit.json.
 *
 * Classifies every canonical action's assertion set per spec:
 *   agreement           — ≥2 providers, same normalized semantics
 *   semantic_divergence — ≥2 providers, differing semantics
 *   provider_only_alpha / provider_only_tiingo — single-source assertions
 *   ambiguous           — assertion rows that couldn't attach (action_id NULL)
 *
 * Plus the hard-integrity checks (all target 0): assertions missing
 * instrument/observation, broken version chains, duplicate provider
 * assertions where forbidden, orphaned derivations.
 *
 * And the Phase 13 diagnostic: sessions where Tiingo EOD asserted
 * divCash≠0 or splitFactor≠1 are checked against raw-vs-adjusted
 * differences — labelled diagnostics only, never a verdict on Tiingo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connectDb } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const dbUrl = process.env.DATABASE_URL?.includes("supabase")
  ? process.env.DATABASE_URL
  : process.env.SUPABASE_DB_PASS
    ? `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(
        process.env.SUPABASE_DB_PASS,
      )}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
    : undefined;
if (!dbUrl) throw new Error("DATABASE_URL or SUPABASE_DB_PASS required");
const c = connectDb(dbUrl);
await c.connect();

const q = async (sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rows;
const n = async (sql: string, params: unknown[] = []) =>
  Number((await c.query(sql, params)).rows[0].n);

// ── per-action agreement classification ──────────────────────────────────
const actions = await q(
  `SELECT ca.id, ca.canonical_key, ca.action_type, ca.status,
          ca.instrument_id, ca.current_version_id
     FROM corporate_actions ca ORDER BY ca.canonical_key`,
);

// assertion semantics compared after decimal canonicalization in SQL —
// '0.25' ≡ '0.2500' via a normalized-cast text projection
const SEMANTIC_SQL = `
  SELECT a.id AS assertion_id, a.provider, a.dataset, a.action_id,
         to_char(a.ex_date,'YYYY-MM-DD') AS ex_date,
         to_char(a.declaration_date,'YYYY-MM-DD') AS declaration_date,
         to_char(a.record_date,'YYYY-MM-DD') AS record_date,
         to_char(a.payment_date,'YYYY-MM-DD') AS payment_date,
         a.cash_amount::text AS cash_amount, a.currency,
         a.split_from::text AS split_from, a.split_to::text AS split_to,
         a.split_factor::text AS split_factor, a.provider_status
    FROM corporate_action_assertions a`;

const dec = (v: string | null): string => {
  if (v == null) return "";
  const s = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return `!${s}`;
  const [i, f = ""] = s.split(".");
  const nf = f.replace(/0+$/, "");
  return `${i}${nf ? "." + nf : ""}`;
};
// NULL ("provider didn't assert") never counts as divergence — only a
// field where BOTH providers assert different values does
const CMP: [string, boolean][] = [
  ["ex_date", false],
  ["declaration_date", false],
  ["record_date", false],
  ["payment_date", false],
  ["cash_amount", true],
  ["currency", false],
  ["split_from", true],
  ["split_to", true],
  ["split_factor", true],
];
const divergentFields = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] =>
  CMP.filter(([f, isDec]) => {
    const va = a[f];
    const vb = b[f];
    if (va == null || vb == null) return false; // absent ≠ disagreement
    return isDec
      ? dec(String(va)) !== dec(String(vb))
      : String(va) !== String(vb);
  }).map(([f]) => f);

const assertions = await q(SEMANTIC_SQL);
const byAction = new Map<string, Record<string, unknown>[]>();
for (const a of assertions) {
  const k = String(a.action_id);
  if (!byAction.has(k)) byAction.set(k, []);
  byAction.get(k)!.push(a);
}

let agreements = 0;
let divergences = 0;
let providerOnlyAlpha = 0;
let providerOnlyTiingo = 0;
const divergentActions: Record<string, unknown>[] = [];
for (const act of actions) {
  const rows = byAction.get(String(act.id)) ?? [];
  const providers = new Set(rows.map((r) => r.provider));
  if (providers.size <= 1) {
    if (providers.has("alphavantage")) providerOnlyAlpha++;
    else if (providers.has("tiingo")) providerOnlyTiingo++;
    continue;
  }
  // cross-provider pairwise: any shared-field disagreement → divergence
  const diff = new Set<string>();
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++)
      if (rows[i].provider !== rows[j].provider)
        for (const f of divergentFields(rows[i], rows[j])) diff.add(f);
  if (!diff.size) agreements++;
  else {
    divergences++;
    divergentActions.push({
      canonicalKey: act.canonical_key,
      providers: [...providers],
      divergentFields: [...diff],
      claims: rows.map((r) => ({
        provider: r.provider,
        dataset: r.dataset,
        exDate: r.ex_date,
        cashAmount: r.cash_amount,
        splitFactor: r.split_factor,
        paymentDate: r.payment_date,
        recordDate: r.record_date,
        declarationDate: r.declaration_date,
      })),
    });
  }
}

// ── Phase 13 diagnostic — raw-vs-adjusted around EOD CA sessions ─────────
const eodSessions = await q(
  `SELECT a.ex_date, l.id AS listing_id, l.canonical_key AS listing_key
     FROM corporate_action_assertions a
     JOIN instrument_listings l ON l.id = a.source_listing_id
    WHERE a.provider='tiingo' AND a.dataset='eod_daily'`,
);
const adjustmentDiagnostics: Record<string, unknown>[] = [];
for (const s of eodSessions) {
  const r = await q(
    `SELECT
       max(CASE WHEN ms.price_basis='as_traded'
                THEN mpv.close::text END) AS raw_close,
       max(CASE WHEN ms.price_basis='provider_adjusted'
                THEN mpv.close::text END) AS adj_close,
       max(CASE WHEN ms.price_basis='as_traded'
                THEN (mpv.observation_id::text) END) AS raw_obs,
       max(CASE WHEN ms.price_basis='provider_adjusted'
                THEN (mpv.observation_id::text) END) AS adj_obs
      FROM market_points mp
      JOIN market_series ms ON ms.id = mp.series_id
        AND ms.listing_id = $1 AND ms.provider='tiingo'
        AND ms.dataset='eod_daily'
      JOIN market_point_versions mpv ON mpv.id = mp.current_version_id
     WHERE mp.session_date = $2::date`,
    [s.listing_id, s.ex_date],
  );
  const row = r[0];
  if (row?.raw_close != null && row?.adj_close != null)
    adjustmentDiagnostics.push({
      listing: s.listing_key,
      exDate: s.ex_date,
      rawClose: row.raw_close,
      adjClose: row.adj_close,
      closesDiffer: dec(row.raw_close) !== dec(row.adj_close),
      sameObservation: row.raw_obs === row.adj_obs,
    });
}

// ── integrity (all target 0) ──────────────────────────────────────────────
const ambiguous = await n(
  `SELECT count(*) n FROM corporate_action_assertions WHERE action_id IS NULL`,
);
const integrity = {
  missingInstrument: await n(
    `SELECT count(*) n FROM corporate_action_assertions a
      WHERE NOT EXISTS (SELECT 1 FROM financial_instruments f
                         WHERE f.id = a.instrument_id)`,
  ),
  missingObservation:
    (await n(
      `SELECT count(*) n FROM corporate_action_assertions a
      WHERE NOT EXISTS (SELECT 1 FROM reference_observations o
                         WHERE o.id = a.observation_id)`,
    )) +
    (await n(
      `SELECT count(*) n FROM corporate_action_versions v
      WHERE NOT EXISTS (SELECT 1 FROM reference_observations o
                         WHERE o.id = v.observation_id)`,
    )),
  badVersionChains:
    (await n(
      `SELECT count(*) n FROM corporate_action_versions v
      WHERE (v.version_no = 1 AND v.previous_version_id IS NOT NULL)
         OR (v.version_no > 1 AND v.previous_version_id IS NULL)`,
    )) +
    (await n(
      `SELECT count(*) n FROM corporate_action_versions v
       JOIN corporate_action_versions p ON p.id = v.previous_version_id
      WHERE p.action_id <> v.action_id OR p.version_no <> v.version_no - 1`,
    )) +
    (await n(
      `SELECT count(*) n FROM corporate_actions ca
        JOIN corporate_action_versions v ON v.id = ca.current_version_id
       WHERE v.action_id <> ca.id`,
    )) +
    (await n(
      `SELECT count(*) n FROM corporate_actions ca
        JOIN corporate_action_versions v ON v.id = ca.current_version_id
       WHERE v.version_no <> (SELECT max(version_no)
            FROM corporate_action_versions x WHERE x.action_id = ca.id)`,
    )),
  duplicateProviderAssertions: await n(
    `SELECT count(*) n FROM (
        SELECT provider, dataset, provider_record_key, observation_id
          FROM corporate_action_assertions
         GROUP BY 1,2,3,4 HAVING count(*) > 1) t`,
  ),
  actionsWithoutCurrentVersion: await n(
    `SELECT count(*) n FROM corporate_actions WHERE current_version_id IS NULL`,
  ),
  assertionsWithoutDerivation: await n(
    `SELECT count(*) n FROM corporate_action_assertions a
      WHERE a.action_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM corporate_action_derivations d
         WHERE d.assertion_id = a.id)`,
  ),
  cancelledActions: await n(
    `SELECT count(*) n FROM corporate_actions WHERE status='cancelled'`,
  ),
};

// ── adjusted-series coverage ──────────────────────────────────────────────
const adjusted = {
  adjustedSeries: await n(
    `SELECT count(*) n FROM market_series WHERE price_basis='provider_adjusted'`,
  ),
  adjustedPoints: await n(
    `SELECT count(*) n FROM market_points mp
       JOIN market_series ms ON ms.id = mp.series_id
      WHERE ms.price_basis='provider_adjusted'`,
  ),
  adjustedVersions: await n(
    `SELECT count(*) n FROM market_point_versions v
       JOIN market_points mp ON mp.id = v.point_id
       JOIN market_series ms ON ms.id = mp.series_id
      WHERE ms.price_basis='provider_adjusted'`,
  ),
  /** fraction (count) of adjusted versions whose observation ALSO carries
   *  the as_traded version — proves one raw payload feeds both series */
  rawAdjustedSameObservationCoverage: await n(
    `SELECT count(*) n FROM (
        SELECT DISTINCT v.observation_id
          FROM market_point_versions v
          JOIN market_points mp ON mp.id = v.point_id
          JOIN market_series ms ON ms.id = mp.series_id
         WHERE ms.price_basis='provider_adjusted' AND v.observation_id IS NOT NULL
      ) adj
      WHERE EXISTS (
        SELECT 1 FROM market_point_versions v2
          JOIN market_points mp2 ON mp2.id = v2.point_id
          JOIN market_series ms2 ON ms2.id = mp2.series_id
         WHERE ms2.price_basis='as_traded' AND ms2.provider='tiingo'
           AND v2.observation_id = adj.observation_id)`,
  ),
};

const audit = {
  generatedAt: new Date().toISOString(),
  actions: actions.length,
  versions: await n(`SELECT count(*) n FROM corporate_action_versions`),
  assertions: await n(`SELECT count(*) n FROM corporate_action_assertions`),
  dividends: await n(
    `SELECT count(*) n FROM corporate_actions WHERE action_type='cash_dividend'`,
  ),
  splits: await n(
    `SELECT count(*) n FROM corporate_actions WHERE action_type='stock_split'`,
  ),
  byProvider: await q(
    `SELECT provider, dataset, count(*) n
       FROM corporate_action_assertions
      GROUP BY provider, dataset ORDER BY provider, dataset`,
  ),
  agreements,
  divergences,
  providerOnly: { alphavantage: providerOnlyAlpha, tiingo: providerOnlyTiingo },
  ambiguous,
  divergentActions,
  derivations: await n(`SELECT count(*) n FROM corporate_action_derivations`),
  derivationsByRole: await q(
    `SELECT role, count(*) n FROM corporate_action_derivations
      GROUP BY role ORDER BY role`,
  ),
  ...integrity,
  ...adjusted,
  adjustmentDiagnostics,
  adjustmentDiagnosticsNote:
    "Diagnostic only: divCash/splitFactor sessions are checked against " +
    "raw-vs-adjusted close differences. No local adjustment formula is " +
    "used; a mismatch is never evidence Tiingo is wrong.",
};
await c.end();
writeFileSync(
  "bench/corporate-actions-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `ca-audit: actions=${audit.actions} versions=${audit.versions} ` +
    `assertions=${audit.assertions} (div=${audit.dividends} split=${audit.splits}) ` +
    `agree=${agreements} diverge=${divergences} ` +
    `onlyA=${providerOnlyAlpha} onlyT=${providerOnlyTiingo} ambiguous=${ambiguous} ` +
    `| integrity: ${Object.entries(integrity)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")} ` +
    `| adjusted series=${adjusted.adjustedSeries} pts=${adjusted.adjustedPoints} ` +
    `vers=${adjusted.adjustedVersions} sameObs=${adjusted.rawAdjustedSameObservationCoverage}`,
);
