/* Macro Data — DB apply layer (pg-mem testable).
 *
 * Revision semantics (vintage-aware):
 *   a version row asserts "at vintage_date V, obs_date D had value X".
 *   identical (V, X) already recorded → 0 new versions (idempotent rerun)
 *   new (V, X) pair → version_no+1, current_version_id moves; history
 *   is never rewritten. FRED revisions surface as new vintage_dates.
 */
import type { Pool } from "pg";
import type { FredObservation, FredSeriesMeta } from "../macro";

type Q = Pick<Pool, "query">;

export const FRED_PROVIDER = "fred";
export const FRED_SERIES_DATASET = "series_observations";

/** get-or-create the canonical macro series for (provider, series_code).
 *  The tuple IS the identity; canonical_key is a label. */
export async function getOrCreateMacroSeries(
  db: Q,
  s: {
    provider?: string;
    seriesCode: string;
    meta?: FredSeriesMeta;
    entityId?: string | null;
  },
): Promise<string> {
  const provider = s.provider ?? FRED_PROVIDER;
  const key = `macro_series:${provider}:${s.seriesCode}`;
  const ex = await db.query(
    `SELECT id FROM macro_series WHERE provider=$1 AND series_code=$2`,
    [provider, s.seriesCode],
  );
  if (ex.rows.length) return ex.rows[0].id as string;
  const ins = await db.query(
    `INSERT INTO macro_series
       (canonical_key, provider, series_code, title, frequency, units,
        seasonal_adjustment, entity_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (provider, series_code) DO NOTHING
     RETURNING id`,
    [
      key,
      provider,
      s.seriesCode,
      s.meta?.title ?? null,
      s.meta?.frequencyShort ?? s.meta?.frequency ?? null,
      s.meta?.units ?? null,
      s.meta?.seasonalAdjustment ?? null,
      s.entityId ?? null,
      s.meta
        ? JSON.stringify({ title: s.meta.title, notes: s.meta.notes })
        : "{}",
    ],
  );
  if (ins.rows.length) return ins.rows[0].id as string;
  return (
    await db.query(
      `SELECT id FROM macro_series WHERE provider=$1 AND series_code=$2`,
      [provider, s.seriesCode],
    )
  ).rows[0].id as string;
}

export interface ApplyMacroResult {
  seriesId: string;
  pointsInserted: number;
  versionsInserted: number;
  unchanged: number;
}

export async function applyMacroObservations(
  db: Q,
  seriesId: string,
  obs: FredObservation[],
  observationId: string,
): Promise<ApplyMacroResult> {
  const res: ApplyMacroResult = {
    seriesId,
    pointsInserted: 0,
    versionsInserted: 0,
    unchanged: 0,
  };
  for (const o of obs) {
    // get-or-create the stable (series, obs_date) point — same pg-mem-safe
    // pattern as market_points.
    const ex = await db.query(
      `SELECT id FROM macro_points WHERE series_id=$1 AND obs_date=$2`,
      [seriesId, o.obsDate],
    );
    let pointId = ex.rows[0]?.id as string | undefined;
    if (pointId == null) {
      const p = await db.query(
        `INSERT INTO macro_points (series_id, obs_date)
         VALUES ($1,$2)
         ON CONFLICT (series_id, obs_date) DO NOTHING
         RETURNING id`,
        [seriesId, o.obsDate],
      );
      pointId =
        (p.rows[0]?.id as string | undefined) ??
        ((
          await db.query(
            `SELECT id FROM macro_points WHERE series_id=$1 AND obs_date=$2`,
            [seriesId, o.obsDate],
          )
        ).rows[0].id as string);
      res.pointsInserted++;
    }

    // dedupe: this exact (vintage_date, value) assertion already recorded?
    const dup = await db.query(
      `SELECT id FROM macro_point_versions
        WHERE point_id=$1 AND vintage_date=$2 AND value=$3::numeric`,
      [pointId, o.vintageDate, o.value],
    );
    if (dup.rows.length) {
      res.unchanged++;
      continue;
    }
    const cur = await db.query(
      `SELECT mpv.* FROM macro_points mp
         JOIN macro_point_versions mpv ON mpv.id = mp.current_version_id
        WHERE mp.id=$1`,
      [pointId],
    );
    const curRow = cur.rows[0] ?? null;
    const no = curRow ? (curRow.version_no as number) + 1 : 1;
    const nv = await db.query(
      `INSERT INTO macro_point_versions
         (point_id, version_no, vintage_date, value, observation_id,
          previous_version_id)
       VALUES ($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
      [pointId, no, o.vintageDate, o.value, observationId, curRow?.id ?? null],
    );
    await db.query(
      `UPDATE macro_points SET current_version_id=$1 WHERE id=$2`,
      [nv.rows[0].id, pointId],
    );
    res.versionsInserted++;
  }
  return res;
}
