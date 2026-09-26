/* Shared market-ingest helpers — one implementation for all provider
 * importers. The provider adapters differ in transport/auth/parsing;
 * integrity measurement is identical everywhere. */
import type { Pool, PoolClient } from "pg";

type Q = Pick<PoolClient, "query"> | Pick<Pool, "query">;

/** Cross-table integrity metrics — every entry targets 0 except the
 *  descriptive counts. Provider-agnostic: runs against whatever series
 *  exist. */
export async function marketIntegrity(c: Q) {
  const count = async (q: string, params: unknown[] = []) =>
    Number((await c.query(q, params)).rows[0].n);
  return {
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
    // ── pointer/chain/provenance integrity (all target 0) ────────────────
    pointsWithMissingCurrentVersion: await count(
      `SELECT count(*) n FROM market_points WHERE current_version_id IS NULL`,
    ),
    pointsWhoseCurrentVersionBelongsElsewhere: await count(
      `SELECT count(*) n FROM market_points mp
         JOIN market_point_versions v ON v.id = mp.current_version_id
        WHERE v.point_id <> mp.id`,
    ),
    /** current pointer is on the right point but not on the LATEST version
     *  — the composite FK (0024) can't catch "wrong version of same point" */
    staleCurrentPointers: await count(
      `SELECT count(*) n FROM market_points mp
         JOIN market_point_versions v ON v.id = mp.current_version_id
        WHERE v.version_no <> (
          SELECT max(version_no) FROM market_point_versions x
           WHERE x.point_id = mp.id)`,
    ),
    versionsWhosePreviousBelongsElsewhere: await count(
      `SELECT count(*) n FROM market_point_versions v
         JOIN market_point_versions p ON p.id = v.previous_version_id
        WHERE p.point_id <> v.point_id`,
    ),
    /** vN (N>1) must link to version_no = N-1 of the SAME point —
     *  adjacent chain, no skipped numbers */
    nonAdjacentPreviousLinks: await count(
      `SELECT count(*) n FROM market_point_versions v
         JOIN market_point_versions p ON p.id = v.previous_version_id
        WHERE p.version_no <> v.version_no - 1`,
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
    /** per-provider row counts — proves series isolation on read-back */
    byProvider: (
      await c.query(
        `SELECT ms.provider, ms.dataset,
              count(DISTINCT ms.id)  AS series,
              count(DISTINCT mp.id)  AS points,
              count(mpv.id)          AS versions
         FROM market_series ms
         LEFT JOIN market_points mp ON mp.series_id = ms.id
         LEFT JOIN market_point_versions mpv ON mpv.point_id = mp.id
        GROUP BY ms.provider, ms.dataset
        ORDER BY ms.provider, ms.dataset`,
      )
    ).rows,
    marketObservationsByProvider: (
      await c.query(
        `SELECT provider, dataset, count(*) n
         FROM reference_observations
        WHERE dataset IN ('time_series_daily','eod_daily','eod_metadata')
        GROUP BY provider, dataset ORDER BY provider, dataset`,
      )
    ).rows,
  };
}
