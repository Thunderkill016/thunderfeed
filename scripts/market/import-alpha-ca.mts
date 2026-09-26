/* Alpha Vantage DIVIDENDS/SPLITS importer — Corporate Actions V1.
 *
 *   npx tsx scripts/market/import-alpha-ca.mts
 *     [--listing <canonical_key|id>] [--limit N] [--dry-run]
 *
 * Flow per listing × endpoint (DIVIDENDS, SPLITS):
 *   listing → verified transport symbol → provider GET →
 *   reference_observations FIRST → one transaction → assertions via
 *   applyActionAssertion (asserted/corroborated/corrected/conflicted/
 *   deduped — provider truth is never merged or averaged).
 *
 * Alpha contract (probed live):
 *   DIVIDENDS → {symbol, data:[{ex_date,declaration_date,record_date,
 *                               payment_date,amount}]}
 *   SPLITS    → {symbol, data:[{effective_date,split_factor}]}
 * Missing provider fields stay NULL — never inferred.
 *
 * Requires ALPHAVANTAGE_API_KEY — never logged or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolveAlphaVantageSymbol } from "../../lib/market.ts";
import {
  parseAlphaDividends,
  parseAlphaSplits,
  type AlphaCaResult,
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

const apiKey = process.env.ALPHAVANTAGE_API_KEY;
if (!apiKey) {
  console.error(
    "ALPHAVANTAGE_API_KEY not set — production ingestion stops here. " +
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

for (const l of listings.rows) {
  const sym = resolveAlphaVantageSymbol({
    mic: l.mic as string,
    ticker: l.ticker as string,
  });
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

  for (const [fn, parser, type] of [
    ["DIVIDENDS", parseAlphaDividends, "cash_dividend"],
    ["SPLITS", parseAlphaSplits, "stock_split"],
  ] as const) {
    requested++;
    const dataset = fn.toLowerCase();
    const url =
      `https://www.alphavantage.co/query?function=${fn}` +
      `&symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
    let payload: unknown;
    try {
      // Alpha free tier: ~1 req/sec. A rate-limit Notice is transient —
      // one retry after pacing, then it's recorded as provider_error.
      payload = await fetch(url).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      const p0 = payload as Record<string, unknown>;
      if (
        typeof p0?.["Information"] === "string" ||
        typeof p0?.["Note"] === "string"
      ) {
        await new Promise((r2) => setTimeout(r2, 5000));
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        payload = await res2.json();
      }
      // SECURITY: Alpha's rate-limit notice echoes the API key back
      // ("your API key as …") — scrub it before the payload is ever
      // persisted or logged
      const asText = JSON.stringify(payload);
      if (asText.includes(apiKey))
        payload = JSON.parse(asText.replaceAll(apiKey, "[REDACTED]"));
    } catch (e) {
      providerErrors++;
      errors.push({
        listing: l.canonical_key,
        kind: "http_error",
        detail: (e as Error).message,
      });
      continue;
    }

    // raw response lands in evidence FIRST — even an error body is a real
    // provider response worth keeping
    const obsId = DRY_RUN
      ? "dry"
      : await observe(c, {
          provider: "alphavantage",
          dataset,
          recordKey: `listing:${l.id}:ticker:${ticker}:${dataset}`,
          sourceUrl:
            `https://www.alphavantage.co/query?function=${fn}` +
            `&symbol=${encodeURIComponent(ticker)}`,
          payload,
        });
    observations++;

    const parsed: AlphaCaResult = parser(payload);
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

    if (DRY_RUN) {
      audit.runs.push({
        listing: l.canonical_key,
        ticker,
        endpoint: fn,
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
        endpoint: fn,
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
          provider: "alphavantage",
          dataset,
          providerRecordKey: `${ticker}:${dataset}:${s.exDate}`,
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
    // free-tier pacing — the capability probe showed bursts trigger the
    // Information rate-limit notice; 5s keeps us under the per-second cap
    // across endpoint loops
    await new Promise((r2) => setTimeout(r2, 5000));
  }
}

audit.metrics = {
  providers: "alphavantage",
  datasets: ["dividends", "splits"],
  requested,
  successful,
  providerErrors,
  rateLimitResponses: rateLimited,
  unresolvedProviderSymbols: unresolvedSymbols,
  observations,
  assertions,
  deduped,
  asserted,
  corroborated,
  corrected,
  conflicted,
  errors,
};
await c.end();
writeFileSync(
  "bench/market-alpha-ca-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `alphavantage-ca: requested=${requested} ok=${successful} ` +
    `providerErrors=${providerErrors} rateLimited=${rateLimited} ` +
    `unresolvedSymbols=${unresolvedSymbols} obs=${observations} ` +
    `assertions=${assertions} (asserted=${asserted} corroborated=${corroborated} ` +
    `corrected=${corrected} conflicted=${conflicted} deduped=${deduped})`,
);
