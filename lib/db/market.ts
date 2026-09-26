/* Market Data — DB apply layer (pg-mem testable).
 *
 * Normalization is atomic per listing ingestion:
 *   one bar invalid → the whole batch rolls back (provider payload stays
 *   in reference_observations — evidence is kept, nothing half-promoted).
 *
 * Revision semantics:
 *   same (series, session_date) + same OHLCV → 0 new versions
 *   same (series, session_date) + different OHLCV → version_no+1,
 *   current_version_id moves; old row stays queryable. Never UPDATE a
 *   version's values in place.
 */
import type { Pool } from "pg";
import { marketPointChanged, validateBar, type DailyBar } from "../market";

type Q = Pick<Pool, "query">;

export const AV_PROVIDER = "alphavantage";
export const AV_DAILY_DATASET = "time_series_daily";

/** get-or-create the canonical series for (listing, provider, dataset).
 *  V1 fixes interval/session_type/price_basis — the tuple is the
 *  identity, the canonical_key just a label. */
export async function getOrCreateSeries(
  db: Q,
  listingId: string,
  listingKey: string,
): Promise<string> {
  const key =
    `series:${listingKey}:${AV_PROVIDER}:${AV_DAILY_DATASET}` +
    `:1d:regular:as_traded`;
  const ins = await db.query(
    `INSERT INTO market_series
       (canonical_key, listing_id, provider, dataset, "interval",
        session_type, price_basis)
     VALUES ($1,$2,$3,$4,'1d','regular','as_traded')
     ON CONFLICT (listing_id, provider, dataset, "interval",
                  session_type, price_basis)
     DO NOTHING
     RETURNING id`,
    [key, listingId, AV_PROVIDER, AV_DAILY_DATASET],
  );
  if (ins.rows.length) return ins.rows[0].id as string;
  const sel = await db.query(
    `SELECT id FROM market_series
      WHERE listing_id=$1 AND provider=$2 AND dataset=$3
        AND "interval"='1d' AND session_type='regular'
        AND price_basis='as_traded'`,
    [listingId, AV_PROVIDER, AV_DAILY_DATASET],
  );
  return sel.rows[0].id as string;
}

export interface ApplyDailyResult {
  seriesId: string;
  pointsInserted: number;
  versionsInserted: number;
  unchanged: number;
  /** bars rejected by validation — raw observation still kept upstream */
  invalid: { sessionDate: string; reason: string }[];
}

export async function applyDailyBars(
  db: Q,
  seriesId: string,
  bars: DailyBar[],
  observationId: string,
): Promise<ApplyDailyResult> {
  const res: ApplyDailyResult = {
    seriesId,
    pointsInserted: 0,
    versionsInserted: 0,
    unchanged: 0,
    invalid: [],
  };
  for (const bar of bars) {
    const v = validateBar(bar);
    if (!v.ok) {
      res.invalid.push({ sessionDate: bar.sessionDate, reason: v.reason });
      continue;
    }
    // get-or-create the stable (series, session_date) point.
    // NB: pg-mem wrongly returns a row for ON CONFLICT DO NOTHING +
    // RETURNING, so existence is checked explicitly, and "inserted" is
    // counted only when the SELECT missed.
    const ex = await db.query(
      `SELECT id FROM market_points
        WHERE series_id=$1 AND session_date=$2`,
      [seriesId, bar.sessionDate],
    );
    let pointId = ex.rows[0]?.id as string | undefined;
    if (pointId == null) {
      const p = await db.query(
        `INSERT INTO market_points (series_id, session_date)
         VALUES ($1,$2)
         ON CONFLICT (series_id, session_date) DO NOTHING
         RETURNING id`,
        [seriesId, bar.sessionDate],
      );
      pointId =
        (p.rows[0]?.id as string | undefined) ??
        ((
          await db.query(
            `SELECT id FROM market_points
              WHERE series_id=$1 AND session_date=$2`,
            [seriesId, bar.sessionDate],
          )
        ).rows[0].id as string);
      res.pointsInserted++;
    }

    const cur = await db.query(
      `SELECT mpv.* FROM market_points mp
         JOIN market_point_versions mpv ON mpv.id = mp.current_version_id
        WHERE mp.id=$1`,
      [pointId],
    );
    const curRow = cur.rows[0] ?? null;
    const next = {
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      currency: null, // provider didn't assert — never guessed
    };
    if (curRow && !marketPointChanged(curRow, next)) {
      res.unchanged++;
      continue;
    }
    const no = curRow ? (curRow.version_no as number) + 1 : 1;
    const nv = await db.query(
      `INSERT INTO market_point_versions
         (point_id, version_no, open, high, low, close, volume, currency,
          observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10) RETURNING id`,
      [
        pointId,
        no,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        null,
        observationId,
        curRow?.id ?? null,
      ],
    );
    await db.query(
      `UPDATE market_points SET current_version_id=$1 WHERE id=$2`,
      [nv.rows[0].id, pointId],
    );
    res.versionsInserted++;
  }
  return res;
}
