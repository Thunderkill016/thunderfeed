/* Market Data — DB apply layer (pg-mem testable).
 *
 * Per-bar failure semantics (do not conflate):
 *   one bar invalid → that bar is skipped + audited; the rest of the
 *     batch still promotes (provider payload stays in
 *     reference_observations either way — evidence is kept)
 *   a runtime/DB error during promotion → the whole listing transaction
 *     rolls back; nothing half-promoted.
 *
 * Revision semantics:
 *   same (series, session_date) + same OHLCV → 0 new versions
 *   same (series, session_date) + different OHLCV → version_no+1,
 *   current_version_id moves; old row stays queryable. Never UPDATE a
 *   version's values in place.
 */
import type { Pool } from "pg";
import {
  dailyMovePct,
  marketPointChanged,
  validateBar,
  type DailyBar,
} from "../market";

type Q = Pick<Pool, "query">;

export const AV_PROVIDER = "alphavantage";
export const AV_DAILY_DATASET = "time_series_daily";
export const TIINGO_PROVIDER = "tiingo";
export const TIINGO_EOD_DATASET = "eod_daily";
export const VNDIRECT_PROVIDER = "vndirect";
export const VNDIRECT_DCHART_DATASET = "dchart_eod";

export interface SeriesSpec {
  listingId: string;
  listingKey: string;
  provider: string;
  dataset: string;
  /** V1 dims — the DB CHECKs enforce the lawful set; 'provider_adjusted'
   *  arrived with 0026 and means provider-supplied adjusted bars, never
   *  locally computed. */
  interval?: "1d";
  sessionType?: "regular";
  priceBasis?: "as_traded" | "provider_adjusted";
}

/** get-or-create the canonical series for
 *  (listing, provider, dataset, interval, session_type, price_basis) —
 *  the tuple IS the identity; canonical_key is a label. */
export async function getOrCreateMarketSeries(
  db: Q,
  s: SeriesSpec,
): Promise<string> {
  const interval = s.interval ?? "1d";
  const sessionType = s.sessionType ?? "regular";
  const priceBasis = s.priceBasis ?? "as_traded";
  const key =
    `series:${s.listingKey}:${s.provider}:${s.dataset}` +
    `:${interval}:${sessionType}:${priceBasis}`;
  const ins = await db.query(
    `INSERT INTO market_series
       (canonical_key, listing_id, provider, dataset, "interval",
        session_type, price_basis)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (listing_id, provider, dataset, "interval",
                  session_type, price_basis)
     DO NOTHING
     RETURNING id`,
    [
      key,
      s.listingId,
      s.provider,
      s.dataset,
      interval,
      sessionType,
      priceBasis,
    ],
  );
  if (ins.rows.length) return ins.rows[0].id as string;
  const sel = await db.query(
    `SELECT id FROM market_series
      WHERE listing_id=$1 AND provider=$2 AND dataset=$3
        AND "interval"=$4 AND session_type=$5 AND price_basis=$6`,
    [s.listingId, s.provider, s.dataset, interval, sessionType, priceBasis],
  );
  return sel.rows[0].id as string;
}

/** V1 Alpha Vantage contract. */
export function getOrCreateSeries(
  db: Q,
  listingId: string,
  listingKey: string,
): Promise<string> {
  return getOrCreateMarketSeries(db, {
    listingId,
    listingKey,
    provider: AV_PROVIDER,
    dataset: AV_DAILY_DATASET,
  });
}

/** V1 Tiingo EOD contract — same granularity/session/basis, different
 *  provider identity. Never the same series row as Alpha Vantage. */
export function getOrCreateTiingoEodSeries(
  db: Q,
  listingId: string,
  listingKey: string,
): Promise<string> {
  return getOrCreateMarketSeries(db, {
    listingId,
    listingKey,
    provider: TIINGO_PROVIDER,
    dataset: TIINGO_EOD_DATASET,
  });
}

/** VNDirect dchart EOD contract — VN listings, as_traded bars. */
export function getOrCreateVndirectSeries(
  db: Q,
  listingId: string,
  listingKey: string,
): Promise<string> {
  return getOrCreateMarketSeries(db, {
    listingId,
    listingKey,
    provider: VNDIRECT_PROVIDER,
    dataset: VNDIRECT_DCHART_DATASET,
  });
}

/** Tiingo provider-adjusted series — SAME listing, SAME provider, SAME
 *  dataset, different price_basis. Values are the provider's own adj*
 *  columns; nothing is recomputed from divCash/splitFactor. */
export function getOrCreateTiingoAdjustedSeries(
  db: Q,
  listingId: string,
  listingKey: string,
): Promise<string> {
  return getOrCreateMarketSeries(db, {
    listingId,
    listingKey,
    provider: TIINGO_PROVIDER,
    dataset: TIINGO_EOD_DATASET,
    priceBasis: "provider_adjusted",
  });
}

export interface ApplyDailyResult {
  seriesId: string;
  pointsInserted: number;
  versionsInserted: number;
  unchanged: number;
  /** bars rejected by validation — raw observation still kept upstream */
  invalid: { sessionDate: string; reason: string }[];
  /** market_move deltas minted (material fresh-session moves only) */
  deltas: number;
}

/** A daily close only becomes a `market_move` delta when the move is
 *  material. VN bands are ±7% (HOSE) / ±10% (HNX) / ±15% (UPCoM); US has
 *  none — 5% is the cross-market "big day" floor. */
const MATERIAL_MOVE_PCT = 5;
/** …and only for fresh sessions: history backfill must not mint a delta
 *  for every big day it walks past. */
const MOVE_DELTA_LOOKBACK_DAYS = 3;

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
    deltas: 0,
  };
  let ticker: string | null | undefined; // undefined = not looked up yet
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

    // market_move delta — only on a fresh session's FIRST version
    // (corrections of an already-known session are revisions, not moves),
    // and only when the close moved materially vs the prior session.
    const versionId = nv.rows[0].id as string;
    if (no === 1) {
      const fresh =
        Date.parse(`${bar.sessionDate}T00:00:00Z`) >=
        Date.now() - MOVE_DELTA_LOOKBACK_DAYS * 86400e3;
      const prev = await db.query(
        `SELECT mpv.close FROM market_points mp
           JOIN market_point_versions mpv
             ON mpv.id = mp.current_version_id
          WHERE mp.series_id=$1 AND mp.session_date < $2
          ORDER BY mp.session_date DESC LIMIT 1`,
        [seriesId, bar.sessionDate],
      );
      const pct = dailyMovePct(prev.rows[0]?.close, bar.close);
      if (pct != null && Math.abs(pct) >= MATERIAL_MOVE_PCT && fresh) {
        if (ticker === undefined) {
          const t = await db.query(
            `SELECT lv.ticker, il.canonical_key FROM market_series ms
               JOIN instrument_listings il ON il.id = ms.listing_id
               LEFT JOIN listing_versions lv ON lv.id = il.current_version_id
              WHERE ms.id=$1`,
            [seriesId],
          );
          // fallback: listing:<slug>:<type>:<mic> → <slug>
          ticker =
            (t.rows[0]?.ticker as string | undefined) ??
            String(t.rows[0]?.canonical_key ?? "").split(":")[1] ??
            null;
        }
        const sign = pct > 0 ? "+" : "";
        await db.query(
          `INSERT INTO data_deltas
             (kind, materiality, summary, market_point_id, market_version_id)
           VALUES ('market_move',$1,$2,$3::uuid,$4::uuid)
           ON CONFLICT (market_version_id) DO NOTHING`,
          [
            Math.abs(pct) >= 10 ? "high" : "medium",
            `${ticker ?? "series"} ${sign}${pct.toFixed(1)}% phiên ${bar.sessionDate}`,
            pointId,
            versionId,
          ],
        );
        res.deltas++;
      }
    }
  }
  return res;
}
