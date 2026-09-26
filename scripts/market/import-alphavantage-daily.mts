/* Alpha Vantage TIME_SERIES_DAILY importer — Market Data V1.
 *
 *   npx tsx scripts/market/import-alphavantage-daily.mts
 *     [--listing <canonical_key|id>] [--limit N] [--dry-run]
 *
 * Flow per listing:
 *   listing_id ──► current listing_version.ticker + venue MIC
 *        │        resolveAlphaVantageSymbol (verified US venue set only —
 *        │        unsupported venues are skipped, never guessed)
 *        │        Alpha Vantage GET (raw JSON)
 *        │        → reference_observations (committed as evidence first)
 *        ▼
 *   classify response: series | rate_limit | invalid_symbol | error
 *        ▼
 *   BEGIN ── getOrCreateSeries ── applyDailyBars (validate+revise) ── COMMIT
 *
 * Two distinct failure semantics (do not conflate):
 *   - one INVALID BAR → bar skipped, rest of batch still promotes, the
 *     rejection lands in audit.invalidBars
 *   - a runtime/DB error during promotion → the whole listing transaction
 *     rolls back; the raw observation stays committed either way.
 *
 * Requires ALPHAVANTAGE_API_KEY — absent key stops the run clearly; no
 * unofficial source is substituted. The key is never logged or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseAvDaily,
  resolveAlphaVantageSymbol,
  type AvDailyResult,
} from "../../lib/market.ts";
import {
  applyDailyBars,
  getOrCreateSeries,
  AV_PROVIDER,
  AV_DAILY_DATASET,
} from "../../lib/db/market.ts";
import { connectDb, observe } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const ONLY_LISTING = opt("listing");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;
const AUDIT_ONLY = args.includes("--audit-only");

const audit: {
  generatedAt: string;
  runs: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = { generatedAt: new Date().toISOString(), runs: [], metrics: {} };

const apiKey = process.env.ALPHAVANTAGE_API_KEY;
if (!apiKey && !AUDIT_ONLY) {
  console.error(
    "ALPHAVANTAGE_API_KEY not set — production ingestion stops here. " +
      "Adapters, fixtures and tests are complete; no unofficial source is " +
      "substituted.",
  );
  process.exit(2);
}

// default target: same Supabase pooler URL as audit-db-security.mts;
// --db <url> or DATABASE_URL override it
const dbUrl =
  opt("db") ||
  (process.env.DATABASE_URL?.includes("supabase")
    ? process.env.DATABASE_URL
    : process.env.SUPABASE_DB_PASS
      ? `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(
          process.env.SUPABASE_DB_PASS,
        )}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
      : undefined);
if (!dbUrl) throw new Error("DATABASE_URL or SUPABASE_DB_PASS required");
const c = connectDb(dbUrl);
await c.connect();

// ── listing universe ─────────────────────────────────────────────────────
const listings = await c.query(
  `SELECT l.id, l.canonical_key, lv.ticker, v.mic
     FROM instrument_listings l
     LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
     LEFT JOIN trading_venues v ON v.id = l.venue_id
    WHERE l.status='active' AND lv.ticker IS NOT NULL
      ${ONLY_LISTING ? "AND (l.canonical_key = $2 OR l.id::text = $2)" : ""}
    ORDER BY l.canonical_key
    ${LIMIT ? `LIMIT ${Math.max(1, Math.floor(LIMIT))}` : ""}`,
  ONLY_LISTING ? [ONLY_LISTING] : [],
);

let requested = 0;
let successful = 0;
let providerErrors = 0;
let rateLimited = 0;
let unresolvedSymbols = 0;
let pointsInserted = 0;
let versionsInserted = 0;
let unchanged = 0;
let invalidBars = 0;
const errors: { listing: string; kind: string; detail: string }[] = [];

for (const l of AUDIT_ONLY ? [] : listings.rows) {
  // transport symbol resolution — verified US venues only; unsupported
  // venues are skipped explicitly, never probed with a guessed symbol
  const sym = resolveAlphaVantageSymbol({ mic: l.mic, ticker: l.ticker });
  if (sym.kind !== "symbol") {
    unresolvedSymbols++;
    errors.push({
      listing: l.canonical_key,
      kind: "unresolved_provider_symbol",
      detail: sym.reason,
    });
    continue;
  }
  const ticker = sym.symbol;
  requested++;
  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
    `&symbol=${encodeURIComponent(ticker)}&outputsize=compact` +
    `&apikey=${apiKey}`; // key lives only in the request, never logged
  let payload: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    providerErrors++;
    errors.push({
      listing: l.canonical_key,
      kind: "http_error",
      detail: (e as Error).message,
    });
    continue;
  }

  // raw response lands in evidence FIRST — even a rate-limit note is a
  // real provider response worth keeping
  const obsId = await observe(c, {
    provider: AV_PROVIDER,
    dataset: AV_DAILY_DATASET,
    recordKey: `listing:${l.id}:ticker:${ticker}:compact`,
    sourceUrl:
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
      `&symbol=${encodeURIComponent(ticker)}&outputsize=compact`,
    payload,
  });

  const parsed: AvDailyResult = parseAvDaily(payload);
  if (parsed.kind === "provider_error") {
    providerErrors++;
    if (parsed.errorClass === "rate_limit") rateLimited++;
    errors.push({
      listing: l.canonical_key,
      kind: parsed.errorClass,
      detail: parsed.detail.slice(0, 200),
    });
    continue;
  }
  // provider must echo the transport symbol — a silent/mismatched Meta
  // Data block is a provider error, not a series to promote
  if (!parsed.meta.symbol) {
    providerErrors++;
    errors.push({
      listing: l.canonical_key,
      kind: "unexpected_schema",
      detail: "Meta Data present but '2. Symbol' missing",
    });
    continue;
  }
  if (parsed.meta.symbol.toUpperCase() !== ticker.toUpperCase()) {
    providerErrors++;
    errors.push({
      listing: l.canonical_key,
      kind: "symbol_mismatch",
      detail: `requested ${ticker} but provider metadata says ${parsed.meta.symbol}`,
    });
    continue;
  }

  if (DRY_RUN) {
    audit.runs.push({
      listing: l.canonical_key,
      ticker,
      bars: parsed.bars.length,
      dryRun: true,
    });
    continue;
  }

  // normalized promotion is its own transaction — a bad batch rolls back
  // cleanly while the raw observation above stays committed as evidence
  await c.query("BEGIN");
  try {
    const seriesId = await getOrCreateSeries(
      c,
      l.id as string,
      l.canonical_key as string,
    );
    const r = await applyDailyBars(c, seriesId, parsed.bars, obsId);
    await c.query("COMMIT");
    successful++;
    pointsInserted += r.pointsInserted;
    versionsInserted += r.versionsInserted;
    unchanged += r.unchanged;
    invalidBars += r.invalid.length;
    audit.runs.push({ listing: l.canonical_key, ticker, ...r });
  } catch (e) {
    await c.query("ROLLBACK");
    providerErrors++;
    errors.push({
      listing: l.canonical_key,
      kind: "apply_error",
      detail: (e as Error).message.slice(0, 200),
    });
  }
}

// ── audit metrics (Phase 19) ─────────────────────────────────────────────
const count = async (q: string, params: unknown[] = []) =>
  Number((await c.query(q, params)).rows[0].n);
audit.metrics = {
  providers: AV_PROVIDER,
  requested,
  successful,
  providerErrors,
  rateLimitResponses: rateLimited,
  unresolvedProviderSymbols: unresolvedSymbols,
  pointsInserted,
  versionsInserted,
  unchanged,
  invalidBars,
  series: await count(`SELECT count(*) n FROM market_series`),
  listingsCovered: await count(
    `SELECT count(DISTINCT listing_id) n FROM market_series`,
  ),
  points: await count(`SELECT count(*) n FROM market_points`),
  versions: await count(`SELECT count(*) n FROM market_point_versions`),
  dateMin: (
    await c.query(
      `SELECT to_char(min(session_date),'YYYY-MM-DD') d FROM market_points`,
    )
  ).rows[0].d,
  dateMax: (
    await c.query(
      `SELECT to_char(max(session_date),'YYYY-MM-DD') d FROM market_points`,
    )
  ).rows[0].d,
  duplicateSessionDates: await count(
    `SELECT count(*) n FROM (
       SELECT series_id, session_date FROM market_points
        GROUP BY series_id, session_date HAVING count(*)>1) t`,
  ),
  revisedPoints: await count(
    `SELECT count(*) n FROM market_points mp
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE v.version_no > 1`,
  ),
  orphanMarketPoints: await count(
    `SELECT count(*) n FROM market_points mp
      WHERE NOT EXISTS (
        SELECT 1 FROM market_point_versions v
         WHERE v.point_id = mp.id)`,
  ),
  orphanMarketVersions: await count(
    `SELECT count(*) n FROM market_point_versions v
      WHERE NOT EXISTS (
        SELECT 1 FROM market_points mp WHERE mp.id = v.point_id)`,
  ),
  unchangedRows: unchanged,
  // ── V1.1 pointer/chain/provenance integrity (all target 0) ─────────────
  pointsWithMissingCurrentVersion: await count(
    `SELECT count(*) n FROM market_points WHERE current_version_id IS NULL`,
  ),
  pointsWhoseCurrentVersionBelongsElsewhere: await count(
    `SELECT count(*) n FROM market_points mp
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE v.point_id <> mp.id`,
  ),
  versionsWhosePreviousBelongsElsewhere: await count(
    `SELECT count(*) n FROM market_point_versions v
       JOIN market_point_versions p ON p.id = v.previous_version_id
      WHERE p.point_id <> v.point_id`,
  ),
  // a v1 must have no previous; vN (N>1) must have one — broken otherwise
  brokenPreviousChains: await count(
    `SELECT count(*) n FROM market_point_versions
      WHERE (version_no = 1 AND previous_version_id IS NOT NULL)
         OR (version_no > 1 AND previous_version_id IS NULL)`,
  ),
  invalidPersistedOHLC: await count(
    `SELECT count(*) n FROM market_point_versions
      WHERE NOT (open > 0 AND high > 0 AND low > 0 AND close > 0
                 AND low <= high
                 AND open BETWEEN low AND high
                 AND close BETWEEN low AND high)`,
  ),
  negativePersistedVolume: await count(
    `SELECT count(*) n FROM market_point_versions WHERE volume < 0`,
  ),
  missingObservationProvenance: await count(
    `SELECT count(*) n FROM market_point_versions
      WHERE observation_id IS NULL`,
  ),
  seriesWithoutListing: await count(
    `SELECT count(*) n FROM market_series ms
      WHERE NOT EXISTS (
        SELECT 1 FROM instrument_listings l WHERE l.id = ms.listing_id)`,
  ),
  barsWithUnknownCurrency: await count(
    `SELECT count(*) n FROM market_point_versions WHERE currency IS NULL`,
  ),
  currentBarsPerListing: await count(
    `SELECT count(*) n FROM (
       SELECT ms.listing_id FROM market_series ms
         JOIN market_points mp ON mp.series_id = ms.id
        GROUP BY ms.listing_id) t`,
  ),
  errors,
};
await c.end();
writeFileSync(
  "bench/market-data-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `alphavantage-daily: requested=${requested} ok=${successful} ` +
    `providerErrors=${providerErrors} rateLimited=${rateLimited} ` +
    `unresolvedSymbols=${unresolvedSymbols} ` +
    `points+${pointsInserted} versions+${versionsInserted} ` +
    `unchanged=${unchanged} invalid=${invalidBars}`,
);
