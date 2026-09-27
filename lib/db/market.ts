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
  isoDay,
  marketPointChanged,
  median,
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
   *  locally computed. 'quoted' (0033) marks non-trade quote boards —
   *  gold bid/ask, FX reference rates — where open=low=bid and
   *  high=close=ask per the series' metadata quote convention. */
  interval?: "1d";
  sessionType?: "regular";
  priceBasis?: "as_traded" | "provider_adjusted" | "quoted";
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
 *  none — 5% is the cross-market "big day" floor. Alt assets carry their
 *  own regimes (gold ~1.5%, crypto ~8%, FX ~0.5%), declared per series in
 *  market_series.metadata.materialMovePct — the writer sets it at series
 *  creation so the threshold is stored policy, not a call-site opinion. */
const MATERIAL_MOVE_PCT = 5;
const HIGH_MOVE_PCT = 10;
/** …and only for fresh sessions: history backfill must not mint a delta
 *  for every big day it walks past. */
const MOVE_DELTA_LOOKBACK_DAYS = 3;
/** Horizons (in sessions of the same series) every market_move is scored
 *  against in signal_outcomes — the public track record. */
export const SIGNAL_HORIZONS = [1, 5, 20] as const;

/** Mint one data_deltas row on a market point + its full outcome
 *  scorecard in the same transaction — the delta is a falsifiable claim,
 *  so no signal ever escapes T+1/T+5/T+20 tracking. Shared by
 *  applyDailyBars' built-in detectors and asset-specific importers
 *  (premium_shift, …) that mint deltas on their own logic. Returns the
 *  delta id, or null when the version already carries a delta
 *  (ON CONFLICT — reruns stay idempotent). */
export async function mintMarketDelta(
  db: Q,
  spec: {
    kind: string;
    materiality: string;
    summary: string;
    pointId: string;
    versionId: string;
  },
): Promise<string | null> {
  // one delta per version — uq_data_deltas_market_version backs this, but
  // the explicit pre-check also makes reruns idempotent where ON CONFLICT
  // inference isn't available (pg-mem doesn't see the ALTER-added UNIQUE)
  const dup = await db.query(
    `SELECT 1 FROM data_deltas WHERE market_version_id=$1`,
    [spec.versionId],
  );
  if (dup.rows.length) return null;
  const delta = await db.query(
    `INSERT INTO data_deltas
       (kind, materiality, summary, market_point_id, market_version_id)
     VALUES ($1,$2,$3,$4::uuid,$5::uuid)
     ON CONFLICT (market_version_id) DO NOTHING
     RETURNING id`,
    [spec.kind, spec.materiality, spec.summary, spec.pointId, spec.versionId],
  );
  if (!delta.rows.length) return null;
  const deltaId = delta.rows[0].id as string;
  for (const h of SIGNAL_HORIZONS) {
    await db.query(
      `INSERT INTO signal_outcomes (delta_id, horizon_sessions)
       VALUES ($1,$2)
       ON CONFLICT (delta_id, horizon_sessions) DO NOTHING`,
      [deltaId, h],
    );
  }
  return deltaId;
}

/** volume_spike: volume ≥ mult × median of the prior `lookback` sessions'
 *  volumes — only when the series opts in via metadata (a crypto 3× day
 *  is signal; an index or a quote board has no meaningful volume). */
const VOLUME_SPIKE_DEFAULT_MULT = 3;
const VOLUME_SPIKE_DEFAULT_LOOKBACK = 20;

export async function applyDailyBars(
  db: Q,
  seriesId: string,
  bars: DailyBar[],
  observationId: string,
): Promise<ApplyDailyResult> {
  // series-level policy — declared once at series creation
  const meta = await db.query(
    `SELECT metadata FROM market_series WHERE id=$1`,
    [seriesId],
  );
  const sMeta = (meta.rows[0]?.metadata ?? {}) as Record<string, unknown>;
  const materialMovePct =
    typeof sMeta.materialMovePct === "number" && sMeta.materialMovePct > 0
      ? sMeta.materialMovePct
      : MATERIAL_MOVE_PCT;
  const highMovePct =
    typeof sMeta.highMovePct === "number" && sMeta.highMovePct > materialMovePct
      ? sMeta.highMovePct
      : Math.max(HIGH_MOVE_PCT, materialMovePct * 2);
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

    // deltas — only on a fresh session's FIRST version (corrections of
    // an already-known session are revisions, not moves). market_move
    // can be switched off per series via metadata.moveDelta=false —
    // e.g. %-valued derived series whose own detector replaces it.
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
      if (
        pct != null &&
        Math.abs(pct) >= materialMovePct &&
        fresh &&
        sMeta.moveDelta !== false
      ) {
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
        const deltaId = await mintMarketDelta(db, {
          kind: "market_move",
          materiality: Math.abs(pct) >= highMovePct ? "high" : "medium",
          summary: `${ticker ?? "series"} ${sign}${pct.toFixed(1)}% phiên ${bar.sessionDate}`,
          pointId,
          versionId,
        });
        if (deltaId) res.deltas++;
      }

      // volume_spike — opt-in per series; compares the fresh session's
      // volume to the median of its trailing lookback sessions.
      const volMult =
        typeof sMeta.volumeSpikeMult === "number" && sMeta.volumeSpikeMult > 1
          ? sMeta.volumeSpikeMult
          : null;
      const vol = bar.volume == null ? null : Number(bar.volume);
      if (volMult && vol != null && Number.isFinite(vol) && fresh) {
        const lookback =
          typeof sMeta.volumeSpikeLookback === "number" &&
          sMeta.volumeSpikeLookback >= 5
            ? Math.floor(sMeta.volumeSpikeLookback)
            : VOLUME_SPIKE_DEFAULT_LOOKBACK;
        const base = await db.query(
          `SELECT mv.volume
             FROM (
               SELECT mp.current_version_id FROM market_points mp
                WHERE mp.series_id=$1 AND mp.session_date < $2
                ORDER BY mp.session_date DESC LIMIT $3
             ) p
             JOIN market_point_versions mv ON mv.id = p.current_version_id
            WHERE mv.volume IS NOT NULL AND mv.volume > 0`,
          [seriesId, bar.sessionDate, lookback],
        );
        // median in JS — percentile_cont isn't portable to pg-mem and a
        // ≤lookback-sized sample is trivial to sort
        const med = median(base.rows.map((r) => Number(r.volume)));
        if (med != null && med > 0 && vol >= volMult * med) {
          if (ticker === undefined) {
            const t = await db.query(
              `SELECT lv.ticker, il.canonical_key FROM market_series ms
                 JOIN instrument_listings il ON il.id = ms.listing_id
                 LEFT JOIN listing_versions lv ON lv.id = il.current_version_id
                WHERE ms.id=$1`,
              [seriesId],
            );
            ticker =
              (t.rows[0]?.ticker as string | undefined) ??
              String(t.rows[0]?.canonical_key ?? "").split(":")[1] ??
              null;
          }
          const ratio = vol / med;
          const deltaId = await mintMarketDelta(db, {
            kind: "volume_spike",
            materiality: ratio >= volMult * 2 ? "high" : "medium",
            summary: `${ticker ?? "series"} vol ×${ratio.toFixed(1)} baseline phiên ${bar.sessionDate}`,
            pointId,
            versionId,
          });
          if (deltaId) res.deltas++;
        }
      }
    }
  }
  return res;
}

// ── signal_outcomes ───────────────────────────────────────────────────────

export interface ResolveOutcomesResult {
  resolved: number;
  expired: number;
  stillPending: number;
  errors: string[];
}

/** 60 calendar days with no horizon session means the series stopped
 *  publishing — the outcome can never resolve. */
const OUTCOME_EXPIRE_DAYS = 60;

/** Resolve pending signal_outcomes against later sessions of the same
 *  series. Horizons count trading sessions (the series' own session_date
 *  sequence), never calendar days. A stale pending is marked 'expired',
 *  never dropped silently — the record keeps the miss auditable. */
export async function resolveSignalOutcomes(
  db: Q,
  now = Date.now(),
): Promise<ResolveOutcomesResult> {
  const res: ResolveOutcomesResult = {
    resolved: 0,
    expired: 0,
    stillPending: 0,
    errors: [],
  };
  const pending = await db.query(
    `SELECT so.id AS outcome_id, so.horizon_sessions, so.created_at,
            mp.series_id, mp.session_date AS signal_date,
            sig.close AS signal_close
       FROM signal_outcomes so
       JOIN data_deltas d ON d.id = so.delta_id
       JOIN market_points mp ON mp.id = d.market_point_id
       JOIN market_point_versions sig ON sig.id = d.market_version_id
      WHERE so.status = 'pending'
      ORDER BY mp.session_date`,
  );
  for (const row of pending.rows) {
    const horizon = await db.query(
      `SELECT mp.id AS point_id, mp.session_date, mpv.id AS version_id,
              mpv.close
         FROM market_points mp
         JOIN market_point_versions mpv ON mpv.id = mp.current_version_id
        WHERE mp.series_id = $1 AND mp.session_date > $2
        ORDER BY mp.session_date
        OFFSET $3 LIMIT 1`,
      [row.series_id, row.signal_date, row.horizon_sessions - 1],
    );
    if (!horizon.rows.length) {
      const ageDays = (now - Date.parse(row.created_at)) / 86400e3;
      if (ageDays > OUTCOME_EXPIRE_DAYS) {
        await db.query(
          `UPDATE signal_outcomes
              SET status='expired', resolved_at=now()
            WHERE id=$1`,
          [row.outcome_id],
        );
        res.expired++;
      } else res.stillPending++;
      continue;
    }
    const h = horizon.rows[0];
    const sig = Number(row.signal_close);
    const out = Number(h.close);
    if (!Number.isFinite(sig) || !Number.isFinite(out) || sig === 0) {
      res.errors.push(`${row.outcome_id}: non-numeric close`);
      continue;
    }
    const movePct = ((out - sig) / Math.abs(sig)) * 100;
    await db.query(
      `UPDATE signal_outcomes
          SET status='resolved', outcome_point_id=$2,
              outcome_version_id=$3, outcome_close=$4, move_pct=$5,
              resolved_at=now()
        WHERE id=$1`,
      [row.outcome_id, h.point_id, h.version_id, h.close, movePct],
    );
    res.resolved++;
  }
  return res;
}

// ── premium_shift detector ─────────────────────────────────────────────────
// The SJC-vs-world premium is itself a %-valued series, so "it moved 5%" is
// the wrong lens — the signal is an absolute-percentage-point shift.
// PREMIUM_SHIFT_PP is the material floor: at a ~7-10% premium regime, ±0.75pt
// is a day a gold trader notices (SJC premium history swings in whole points,
// not decimals).

export const PREMIUM_SHIFT_PP = 0.75;
export const PREMIUM_SHIFT_HIGH_PP = 1.5;

/** Compare the two latest sessions of a %-valued series; mint a
 *  premium_shift delta when the latest session moved ≥ PREMIUM_SHIFT_PP
 *  vs the previous one. Same freshness discipline as market_move: first
 *  version of a recent session only — revisions and backfills don't
 *  re-fire the signal. */
export async function detectPremiumShift(
  db: Q,
  seriesId: string,
  now = Date.now(),
  thresholds: { mediumPp: number; highPp: number } = {
    mediumPp: PREMIUM_SHIFT_PP,
    highPp: PREMIUM_SHIFT_HIGH_PP,
  },
): Promise<{ shifted: boolean; deltaPp: number | null }> {
  const pts = await db.query(
    `SELECT mp.id AS point_id, mp.session_date, mpv.id AS version_id,
            mpv.version_no, mpv.close
       FROM market_points mp
       JOIN market_point_versions mpv ON mpv.id = mp.current_version_id
      WHERE mp.series_id=$1
      ORDER BY mp.session_date DESC LIMIT 2`,
    [seriesId],
  );
  if (pts.rows.length < 2) return { shifted: false, deltaPp: null };
  const [cur, prev] = pts.rows;
  const deltaPp = Number(cur.close) - Number(prev.close);
  if (!Number.isFinite(deltaPp)) return { shifted: false, deltaPp: null };
  const curDate = isoDay(cur.session_date); // DB hands back a Date, not "YYYY-MM-DD"
  const fresh =
    Number(cur.version_no) === 1 &&
    Date.parse(`${curDate}T00:00:00Z`) >=
      now - MOVE_DELTA_LOOKBACK_DAYS * 86400e3;
  if (!fresh || Math.abs(deltaPp) < thresholds.mediumPp)
    return { shifted: false, deltaPp };
  const sign = deltaPp > 0 ? "+" : "";
  const deltaId = await mintMarketDelta(db, {
    kind: "premium_shift",
    materiality: Math.abs(deltaPp) >= thresholds.highPp ? "high" : "medium",
    summary: `premium SJC ${sign}${deltaPp.toFixed(2)}pt → ${Number(cur.close).toFixed(2)}% phiên ${curDate}`,
    pointId: cur.point_id,
    versionId: cur.version_id,
  });
  return { shifted: deltaId != null, deltaPp };
}
