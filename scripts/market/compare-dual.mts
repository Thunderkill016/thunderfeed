/* Dual-provider comparison audit — Market Data V1.
 *
 *   npx tsx scripts/market/compare-dual.mts [--listing <canonical_key|id>]
 *
 * For every listing carrying BOTH an Alpha Vantage and a Tiingo daily
 * series, reads each series independently (never merged) and runs the pure
 * compareDailySeries layer. Output → bench/market-dual-provider-v1-audit.json
 *
 * Divergence ≠ ingestion error. Two providers asserting different values
 * for the same session is evidence — it is recorded, never averaged,
 * never silently resolved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  compareDailySeries,
  type SessionComparison,
} from "../../lib/market.ts";
import { AV_PROVIDER, AV_DAILY_DATASET } from "../../lib/db/market.ts";
import { TIINGO_PROVIDER, TIINGO_EOD_DATASET } from "../../lib/db/market.ts";
import { connectDb } from "../instruments/lib.mts";
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
const ONLY_LISTING = opt("listing");

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

/** current bars of one series, oldest→newest, as DailyBar inputs for the
 *  pure comparator — pulled straight from the normalized tables so the
 *  comparison is DB-truth, not provider-memory. */
async function seriesBars(seriesId: string) {
  const r = await c.query(
    `SELECT to_char(mp.session_date,'YYYY-MM-DD') d,
            v.open, v.high, v.low, v.close, v.volume
       FROM market_points mp
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE mp.series_id = $1
      ORDER BY mp.session_date ASC`,
    [seriesId],
  );
  return r.rows.map((x) => ({
    sessionDate: x.d as string,
    open: String(x.open),
    high: String(x.high),
    low: String(x.low),
    close: String(x.close),
    volume: x.volume == null ? null : String(x.volume),
  }));
}

// listings carrying both contracts — the ONLY set comparison is defined on
const pairs = await c.query(
  `SELECT a.id alpha_series_id, t.id tiingo_series_id,
          l.id listing_id, l.canonical_key
     FROM market_series a
     JOIN market_series t
       ON t.listing_id = a.listing_id
      AND t.provider = '${TIINGO_PROVIDER}' AND t.dataset = '${TIINGO_EOD_DATASET}'
      AND t."interval"='1d' AND t.session_type='regular'
      AND t.price_basis='as_traded'
     JOIN instrument_listings l ON l.id = a.listing_id
    WHERE a.provider = '${AV_PROVIDER}' AND a.dataset = '${AV_DAILY_DATASET}'
      AND a."interval"='1d' AND a.session_type='regular'
      AND a.price_basis='as_traded'
      ${ONLY_LISTING ? "AND (l.canonical_key = $1 OR l.id::text = $1)" : ""}
    ORDER BY l.canonical_key`,
  ONLY_LISTING ? [ONLY_LISTING] : [],
);

const comparisons: Record<string, unknown>[] = [];
for (const p of pairs.rows) {
  const alpha = await seriesBars(p.alpha_series_id);
  const tiingo = await seriesBars(p.tiingo_series_id);
  const cmp = compareDailySeries(alpha, tiingo);

  const compared = cmp.filter(
    (x): x is Extract<SessionComparison, { kind: "compared" }> =>
      x.kind === "compared",
  );
  const exact = compared.filter((x) => x.agreement === "exact_agreement");
  const priceDiv = compared.filter((x) => x.agreement === "price_divergence");
  const volDiv = compared.filter((x) => x.agreement === "volume_divergence");
  const perField = (f: "open" | "high" | "low" | "close" | "volume") =>
    compared.filter((x) => x.divergentFields.includes(f)).length;
  const largestClose = compared.reduce(
    (m, x) => (x.closeDiff > (m?.closeDiff ?? -1) ? x : m),
    null as (typeof compared)[number] | null,
  );

  comparisons.push({
    listing: p.canonical_key,
    listingId: p.listing_id,
    alphaSeriesId: p.alpha_series_id,
    tiingoSeriesId: p.tiingo_series_id,
    alphaBars: alpha.length,
    tiingoBars: tiingo.length,
    overlapStart: compared[0]?.sessionDate ?? null,
    overlapEnd: compared[compared.length - 1]?.sessionDate ?? null,
    overlapSessions: compared.length,
    exactAgreementSessions: exact.length,
    priceDivergenceSessions: priceDiv.length,
    volumeDivergenceSessions: volDiv.length,
    missingInAlpha: cmp.filter((x) => x.kind === "missing_in_alpha").length,
    missingInTiingo: cmp.filter((x) => x.kind === "missing_in_tiingo").length,
    openDivergences: perField("open"),
    highDivergences: perField("high"),
    lowDivergences: perField("low"),
    closeDivergences: perField("close"),
    volumeDivergences: perField("volume"),
    largestCloseDifference: largestClose?.closeDiff ?? null,
    largestCloseDifferenceBps: largestClose?.closeDiffBps ?? null,
    sampleDivergences: compared
      .filter((x) => x.agreement !== "exact_agreement")
      .slice(0, 5),
  });
}

const integrity = await marketIntegrity(c);
const hardZeros = [
  "duplicateSessionDates",
  "orphanMarketPoints",
  "orphanMarketVersions",
  "missingObservationProvenance",
  "pointsWithMissingCurrentVersion",
  "pointsWhoseCurrentVersionBelongsElsewhere",
  "staleCurrentPointers",
  "versionsWhosePreviousBelongsElsewhere",
  "nonAdjacentPreviousLinks",
  "brokenPreviousChains",
  "invalidPersistedOHLC",
  "negativePersistedVolume",
  "seriesWithoutListing",
] as const;
const integrityClean = hardZeros.every(
  (k) => (integrity as Record<string, unknown>)[k] === 0,
);
const audit = {
  generatedAt: new Date().toISOString(),
  livePilot: {
    status:
      comparisons.length > 0 && integrityClean
        ? "PASS_DUAL_PROVIDER"
        : comparisons.length > 0
          ? "PARTIAL_DUAL_PROVIDER"
          : "AWAITING_INGESTION",
    listingsCompared: comparisons.length,
    integrityClean,
  },
  crossProviderAudit: {
    listingsCompared: comparisons.length,
    overlappingSessions: comparisons.reduce(
      (s, x) => s + (x.overlapSessions as number),
      0,
    ),
    exactAgreements: comparisons.reduce(
      (s, x) => s + (x.exactAgreementSessions as number),
      0,
    ),
    divergences: comparisons.reduce(
      (s, x) =>
        s +
        (x.priceDivergenceSessions as number) +
        (x.volumeDivergenceSessions as number),
      0,
    ),
    comparisons,
  },
  integrity,
};
await c.end();
writeFileSync(
  "bench/market-dual-provider-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `dual-compare: listings=${comparisons.length} ` +
    `overlap=${audit.crossProviderAudit.overlappingSessions} ` +
    `exact=${audit.crossProviderAudit.exactAgreements} ` +
    `divergent=${audit.crossProviderAudit.divergences}`,
);
