/* Tiingo rich corporate-actions importer — Corporate Actions V1.
 *
 *   npx tsx scripts/market/import-tiingo-ca.mts
 *     [--listing <canonical_key|id>] [--limit N] [--dry-run]
 *
 * Endpoints (entitlement-gated — probed live; free tier returns 403):
 *   /tiingo/corporate-actions/<ticker>/distributions
 *   /tiingo/corporate-actions/<ticker>/splits
 *
 * Semantics: raw response → reference_observations first, then assertions
 * via applyActionAssertion. A 401/403 response is recorded as
 * unauthorized/entitlement_required and the run STOPS probing further —
 * nothing is fabricated; the EOD divCash/splitFactor fallback is the
 * importer in import-tiingo-eod.mts.
 *
 * Auth: Authorization: Token <TIINGO_API_TOKEN> header. The token never
 * enters the URL, logs, errors, or reference_observations.source_url.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolveTiingoSymbol } from "../../lib/market.ts";
import {
  parseTiingoDistributions,
  parseTiingoSplits,
  type TiingoCaResult,
} from "../../lib/corporate-actions.ts";
import { applyActionAssertion } from "../../lib/db/corporate-actions.ts";
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

const token = process.env.TIINGO_API_TOKEN;
if (!token) {
  console.error(
    "TIINGO_API_TOKEN not set — production ingestion stops here. " +
      "Adapters, fixtures and tests are complete; no unofficial source is " +
      "substituted.",
  );
  process.exit(2);
}

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

const listings = await c.query(
  `SELECT l.id, l.canonical_key, l.instrument_id, lv.ticker, v.mic
     FROM instrument_listings l
     LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
     LEFT JOIN trading_venues v ON v.id = l.venue_id
    WHERE l.status='active' AND lv.ticker IS NOT NULL
      ${ONLY_LISTING ? "AND (l.canonical_key = $1 OR l.id::text = $1)" : ""}
    ORDER BY l.canonical_key
    ${LIMIT ? `LIMIT ${Math.max(1, Math.floor(LIMIT))}` : ""}`,
  ONLY_LISTING ? [ONLY_LISTING] : [],
);

const audit: {
  generatedAt: string;
  runs: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = { generatedAt: new Date().toISOString(), runs: [], metrics: {} };

let requested = 0;
let successful = 0;
let providerErrors = 0;
let entitlementBlocked = 0;
let rateLimited = 0;
let unresolvedSymbols = 0;
let observations = 0;
let assertions = 0;
let deduped = 0;
let asserted = 0;
let corroborated = 0;
let corrected = 0;
let conflicted = 0;
const errors: { listing: string; kind: string; detail: string }[] = [];

const classifyHttp = (s: number): string =>
  s === 401
    ? "unauthorized"
    : s === 403
      ? "entitlement_required"
      : s === 404
        ? "invalid_symbol"
        : s === 429
          ? "rate_limit"
          : "api_error";

outer: for (const l of listings.rows) {
  const rs = resolveTiingoSymbol({
    mic: l.mic as string,
    ticker: l.ticker as string,
  });
  if (rs.kind !== "symbol") {
    unresolvedSymbols++;
    errors.push({
      listing: l.canonical_key,
      kind: "unresolved_provider_symbol",
      detail: rs.reason,
    });
    continue;
  }
  const ticker = rs.symbol;

  for (const [endpoint, parser, type] of [
    ["distributions", parseTiingoDistributions, "cash_dividend"],
    ["splits", parseTiingoSplits, "stock_split"],
  ] as const) {
    requested++;
    const url =
      `https://api.tiingo.com/tiingo/corporate-actions/` +
      `${encodeURIComponent(ticker)}/${endpoint}`;
    let payload: unknown;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Token ${token}` },
      });
      if (!res.ok) {
        const cls = classifyHttp(res.status);
        if (cls === "entitlement_required" || cls === "unauthorized") {
          entitlementBlocked++;
          errors.push({
            listing: l.canonical_key,
            kind: cls,
            detail:
              `${endpoint} → HTTP ${res.status} — endpoint requires a ` +
              `paid entitlement; EOD divCash/splitFactor remains the ` +
              `official Tiingo assertion source`,
          });
          // stop hammering an endpoint the token cannot reach
          break outer;
        }
        if (cls === "rate_limit") rateLimited++;
        providerErrors++;
        errors.push({
          listing: l.canonical_key,
          kind: cls,
          detail: `${endpoint} → HTTP ${res.status}`,
        });
        continue;
      }
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

    const obsId = DRY_RUN
      ? "dry"
      : await observe(c, {
          provider: "tiingo",
          dataset: `corporate_actions_${endpoint}`,
          recordKey: `listing:${l.id}:ticker:${ticker}:${endpoint}`,
          sourceUrl: url,
          payload,
        });
    observations++;

    const parsed: TiingoCaResult = parser(payload);
    if (parsed.kind === "provider_error") {
      providerErrors++;
      errors.push({
        listing: l.canonical_key,
        kind: parsed.errorClass,
        detail: parsed.detail.slice(0, 200),
      });
      continue;
    }

    if (DRY_RUN) {
      audit.runs.push({
        listing: l.canonical_key,
        ticker,
        endpoint,
        actions: parsed.actions.length,
        dryRun: true,
      });
      continue;
    }

    await c.query("BEGIN");
    try {
      const run = {
        listing: l.canonical_key,
        ticker,
        endpoint,
        rows: parsed.actions.length,
        asserted: 0,
        corroborated: 0,
        corrected: 0,
        conflicted: 0,
        ambiguous: 0,
        deduped: 0,
      };
      for (const s of parsed.actions) {
        const r = await applyActionAssertion(c, {
          instrumentId: l.instrument_id as string,
          sourceListingId: l.id as string,
          provider: "tiingo",
          dataset: `corporate_actions_${endpoint}`,
          providerRecordKey: `${ticker}:${endpoint}:${s.exDate}`,
          actionType: type,
          ...s,
          observationId: obsId,
        });
        assertions++;
        run[r.outcome]++;
      }
      deduped += run.deduped;
      asserted += run.asserted;
      corroborated += run.corroborated;
      corrected += run.corrected;
      conflicted += run.conflicted;
      await c.query("COMMIT");
      successful++;
      audit.runs.push(run);
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
}

audit.metrics = {
  providers: "tiingo",
  datasets: ["corporate_actions_distributions", "corporate_actions_splits"],
  requested,
  successful,
  providerErrors,
  /** entitlement probe outcome — the run STOPS on the first 401/403 */
  entitlementBlocked,
  rateLimitResponses: rateLimited,
  unresolvedProviderSymbols: unresolvedSymbols,
  observations,
  assertions,
  deduped,
  asserted,
  corroborated,
  corrected,
  conflicted,
  fallbackNote:
    "when entitlement is absent, Tiingo EOD divCash/splitFactor remains " +
    "the official Tiingo assertion source (import-tiingo-eod.mts)",
  errors,
};
await c.end();
writeFileSync(
  "bench/market-tiingo-ca-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `tiingo-ca: requested=${requested} ok=${successful} ` +
    `providerErrors=${providerErrors} entitlementBlocked=${entitlementBlocked} ` +
    `rateLimited=${rateLimited} unresolvedSymbols=${unresolvedSymbols} ` +
    `obs=${observations} assertions=${assertions} (asserted=${asserted} ` +
    `corroborated=${corroborated} corrected=${corrected} ` +
    `conflicted=${conflicted} deduped=${deduped})`,
);
