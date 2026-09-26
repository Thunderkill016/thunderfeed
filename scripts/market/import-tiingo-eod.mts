/* Tiingo EOD importer — Market Data dual-provider V1.
 *
 *   npx tsx scripts/market/import-tiingo-eod.mts
 *     [--listing <canonical_key|id>] [--limit N]
 *     [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--dry-run] [--audit-only]
 *
 * Same chain as the Alpha Vantage adapter — listing → transport symbol →
 * provider response → reference_observation → market_series →
 * market_points → market_point_versions — but a SEPARATE series. Alpha and
 * Tiingo are independent assertions; nothing averages or merges them.
 *
 * Auth: Authorization: Token <TIINGO_API_TOKEN> header. The token never
 * enters the URL, logs, errors, or reference_observations.source_url.
 *
 * Normalization promotes raw OHLCV only — adjOpen/adjHigh/adjLow/adjClose/
 * adjVolume/divCash/splitFactor remain quarantined in the raw payload for
 * the future Corporate Actions phase. price_basis stays as_traded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseTiingoEod,
  resolveTiingoSymbol,
  type TiingoErrorClass,
} from "../../lib/market.ts";
import {
  applyDailyBars,
  getOrCreateTiingoEodSeries,
  TIINGO_PROVIDER,
  TIINGO_EOD_DATASET,
} from "../../lib/db/market.ts";
import { connectDb, observe } from "../instruments/lib.mts";
import { marketIntegrity } from "./lib.mts";

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
const AUDIT_ONLY = args.includes("--audit-only");
const ONLY_LISTING = opt("listing");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const today = isoDay(new Date());
const START = opt("start") ?? isoDay(new Date(Date.now() - 180 * 86400e3));
const END = opt("end") ?? today;
for (const [flag, v] of [
  ["--start", START],
  ["--end", END],
])
  if (!DATE_RE.test(v)) {
    console.error(`${flag} must be YYYY-MM-DD (got '${v}')`);
    process.exit(2);
  }
const WINDOW = `${START}_${END}`;

const audit: {
  generatedAt: string;
  window: { start: string; end: string };
  runs: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = {
  generatedAt: new Date().toISOString(),
  window: { start: START, end: END },
  runs: [],
  metrics: {},
};

const token = process.env.TIINGO_API_TOKEN;
if (!token && !AUDIT_ONLY) {
  console.error(
    "TIINGO_API_TOKEN not set — Tiingo ingestion stops here. " +
      "Adapter, parser and fixtures are complete; no unofficial source is " +
      "substituted.",
  );
  process.exit(2);
}
// Authorization header carries the credential — request URLs stay clean
const headers = { Authorization: `Token ${token}` };

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
  `SELECT l.id, l.canonical_key, lv.ticker, v.mic
     FROM instrument_listings l
     LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
     LEFT JOIN trading_venues v ON v.id = l.venue_id
    WHERE l.status='active' AND lv.ticker IS NOT NULL
      ${ONLY_LISTING ? "AND (l.canonical_key = $1 OR l.id::text = $1)" : ""}
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
const fail = (
  listing: string,
  kind: TiingoErrorClass | "symbol_mismatch" | "http_error" | "apply_error",
  detail: string,
) => {
  providerErrors++;
  if (kind === "rate_limit") rateLimited++;
  errors.push({ listing, kind, detail: detail.slice(0, 200) });
};

for (const l of AUDIT_ONLY ? [] : listings.rows) {
  const sym = resolveTiingoSymbol({ mic: l.mic, ticker: l.ticker });
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

  // ── step 1: metadata verification — official /tiingo/daily/<ticker> ────
  let meta: Record<string, unknown> | null = null;
  try {
    const res = await fetch(
      `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}`,
      { headers },
    );
    const body = await res.text();
    meta = (() => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })() as Record<string, unknown> | null;
    // raw metadata is evidence too — stored before any judgment on it
    await observe(c, {
      provider: TIINGO_PROVIDER,
      dataset: "eod_metadata",
      recordKey: `listing:${l.id}:ticker:${ticker}`,
      sourceUrl: `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}`,
      payload: meta ?? { unparsed: body.slice(0, 500) },
    });
    if (res.status === 401 || res.status === 403) {
      fail(l.canonical_key, "unauthorized", "metadata 401/403");
      continue;
    }
    if (res.status === 404) {
      fail(l.canonical_key, "invalid_symbol", `metadata 404 for ${ticker}`);
      continue;
    }
    if (res.status === 429) {
      fail(l.canonical_key, "rate_limit", "metadata 429");
      continue;
    }
    if (!res.ok) {
      fail(l.canonical_key, "api_error", `metadata HTTP ${res.status}`);
      continue;
    }
  } catch (e) {
    fail(l.canonical_key, "http_error", (e as Error).message);
    continue;
  }
  // metadata must assert the same transport ticker back — structural
  // validation only; it never alters canonical identity
  const metaTicker = typeof meta?.ticker === "string" ? meta.ticker : null;
  if (!meta || metaTicker == null) {
    fail(
      l.canonical_key,
      "unexpected_schema",
      "metadata body missing 'ticker' field",
    );
    continue;
  }
  if (metaTicker.toUpperCase() !== ticker.toUpperCase()) {
    fail(
      l.canonical_key,
      "symbol_mismatch",
      `requested ${ticker} but metadata says ${metaTicker}`,
    );
    continue;
  }
  for (const d of ["startDate", "endDate"]) {
    const v = meta[d];
    if (v != null && (typeof v !== "string" || !DATE_RE.test(v))) {
      fail(
        l.canonical_key,
        "unexpected_schema",
        `metadata ${d} unusable: ${JSON.stringify(v)}`,
      );
      meta = null;
      break;
    }
  }
  if (meta == null) continue;

  // ── step 2: EOD prices (CSV — exact decimal strings, no float parse) ───
  const url =
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}` +
    `/prices?startDate=${START}&endDate=${END}` +
    `&format=csv&resampleFreq=daily`;
  let status = 0;
  let body = "";
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    body = await res.text();
  } catch (e) {
    fail(l.canonical_key, "http_error", (e as Error).message);
    continue;
  }

  // raw CSV lands in evidence first — stored as a JSON string in the
  // existing jsonb payload column; every provider field stays available
  const obsId = await observe(c, {
    provider: TIINGO_PROVIDER,
    dataset: TIINGO_EOD_DATASET,
    recordKey: `listing:${l.id}:ticker:${ticker}:${WINDOW}`,
    sourceUrl: url, // clean — the token is a header, never a URL param
    payload: body,
  });

  const parsed = parseTiingoEod({ status, body });
  if (parsed.kind === "provider_error") {
    fail(l.canonical_key, parsed.errorClass, parsed.detail);
    continue;
  }

  if (DRY_RUN) {
    audit.runs.push({
      listing: l.canonical_key,
      ticker,
      bars: parsed.bars.length,
      dateMin: parsed.bars[0]?.sessionDate,
      dateMax: parsed.bars[parsed.bars.length - 1]?.sessionDate,
      dryRun: true,
    });
    continue;
  }

  // normalized promotion is its own transaction — identical semantics to
  // the Alpha adapter: bad batch rolls back, raw evidence stays committed
  await c.query("BEGIN");
  try {
    const seriesId = await getOrCreateTiingoEodSeries(
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

audit.metrics = {
  providers: TIINGO_PROVIDER,
  requested,
  successful,
  providerErrors,
  rateLimitResponses: rateLimited,
  unresolvedProviderSymbols: unresolvedSymbols,
  pointsInserted,
  versionsInserted,
  unchanged,
  unchangedRows: unchanged,
  invalidBars,
  ...(await marketIntegrity(c)),
  errors,
};
await c.end();
writeFileSync(
  "bench/market-tiingo-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `tiingo-eod: requested=${requested} ok=${successful} ` +
    `providerErrors=${providerErrors} rateLimited=${rateLimited} ` +
    `unresolvedSymbols=${unresolvedSymbols} ` +
    `points+${pointsInserted} versions+${versionsInserted} ` +
    `unchanged=${unchanged} invalid=${invalidBars}`,
);
