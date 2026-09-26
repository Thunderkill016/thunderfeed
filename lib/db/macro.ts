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

/** Batched apply — daily series carry tens of thousands of observations,
 *  so per-row round-trips are out. Three passes keep the same semantics:
 *  get-or-create points → diff against existing versions → bulk-insert
 *  new versions → one DISTINCT ON pointer update per series. */
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

  const readPoints = async () =>
    new Map(
      (
        await db.query(
          `SELECT id, obs_date FROM macro_points WHERE series_id=$1`,
          [seriesId],
        )
      ).rows.map((r) => [isoDateOnly(r.obs_date), r.id as string]),
    );

  let points = await readPoints();
  const missing = [...new Set(obs.map((o) => o.obsDate))].filter(
    (d) => !points.has(d),
  );
  for (const chunk of chunks(missing)) {
    const ph = chunk.map((_, i) => `($1,$${i + 2}::date)`).join(",");
    await db.query(
      `INSERT INTO macro_points (series_id, obs_date)
       VALUES ${ph}
       ON CONFLICT (series_id, obs_date) DO NOTHING`,
      [seriesId, ...chunk],
    );
  }
  if (missing.length) {
    res.pointsInserted = missing.length;
    points = await readPoints();
  }

  // existing versions → dedupe set + per-point max version_no + current id
  const existing = await db.query(
    `SELECT v.point_id, v.id, v.vintage_date, v.value, v.version_no,
            p.current_version_id
       FROM macro_point_versions v
       JOIN macro_points p ON p.id = v.point_id
      WHERE p.series_id=$1`,
    [seriesId],
  );
  const seen = new Set<string>();
  const maxNo = new Map<string, number>();
  const curId = new Map<string, string>();
  for (const r of existing.rows) {
    const pid = r.point_id as string;
    seen.add(`${pid}|${isoDateOnly(r.vintage_date)}|${decimalKey(r.value)}`);
    maxNo.set(pid, Math.max(maxNo.get(pid) ?? 0, r.version_no as number));
    if (r.current_version_id) curId.set(pid, r.current_version_id as string);
  }

  const rows: [string, number, string, string, string, string | null][] = [];
  for (const o of obs) {
    const pid = points.get(o.obsDate);
    if (!pid) continue;
    const key = `${pid}|${o.vintageDate}|${decimalKey(o.value)}`;
    if (seen.has(key)) {
      res.unchanged++;
      continue;
    }
    seen.add(key);
    const no = (maxNo.get(pid) ?? 0) + 1;
    maxNo.set(pid, no);
    rows.push([
      pid,
      no,
      o.vintageDate,
      o.value,
      observationId,
      curId.get(pid) ?? null,
    ]);
  }
  for (const chunk of chunks(rows)) {
    const ph = chunk
      .map(
        (_, i) =>
          `($${i * 6 + 1}::uuid,$${i * 6 + 2},$${i * 6 + 3}::date,` +
          `$${i * 6 + 4}::numeric,$${i * 6 + 5}::uuid,$${i * 6 + 6}::uuid)`,
      )
      .join(",");
    await db.query(
      `INSERT INTO macro_point_versions
         (point_id, version_no, vintage_date, value, observation_id,
          previous_version_id)
       VALUES ${ph}`,
      chunk.flat(),
    );
  }
  res.versionsInserted = rows.length;

  if (rows.length) {
    // current pointer = highest version_no per point (one statement/series).
    // point ids come from the in-memory diff — the UPDATE target's table
    // name must not reappear inside the FROM subquery (pg-mem limitation).
    const touched = [...new Set(rows.map((r) => r[0]))];
    const inPh = touched.map((_, i) => `$${i + 1}`).join(",");
    await db.query(
      `UPDATE macro_points
          SET current_version_id = nv.id
         FROM (
           SELECT DISTINCT ON (point_id) id, point_id
             FROM macro_point_versions
            WHERE point_id IN (${inPh})
            ORDER BY point_id, version_no DESC
         ) nv
        WHERE macro_points.id = nv.point_id`,
      touched,
    );
  }
  return res;
}

const CHUNK = 500;
function* chunks<T>(arr: T[]): Generator<T[]> {
  for (let i = 0; i < arr.length; i += CHUNK) yield arr.slice(i, i + CHUNK);
}
/** DATE from either driver shape — pg returns 'YYYY-MM-DD' text, pg-mem a
 *  Date; both reduce to the day label for dedupe keys. */
function isoDateOnly(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}
/** numeric dedupe must not be text-shaped: '322.560' ≡ 322.56 ≡ '322.56'. */
function decimalKey(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}
