/* job_runs — observable cron jobs (0037). Every batch pass (enrich,
 * adjudicate, relineage…) records: who ran, when, how far it got, what
 * failed. A run that dies at 3000/6000 leaves status='running' with the
 * cursor where it stopped — resumable, and visible without guessing.
 *
 *   const run = await startJob("enrich", { mode: "incremental" });
 *   const since = opts.since ?? await lastDoneCursor("enrich");
 *   ... per-event work, await updateJob(run.id, { processed, cursorTs })
 *   await finishJob(run.id, { processed, failed, cursorTs });
 */
import { getPool } from "./pool";

export interface JobRun {
  id: string;
  cursorTs: string | null;
}

export async function startJob(
  job: string,
  metadata: Record<string, unknown> = {},
): Promise<JobRun> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO job_runs (job, status, metadata) VALUES ($1, 'running', $2)
     RETURNING id`,
    [job, JSON.stringify(metadata)],
  );
  return { id: rows[0].id, cursorTs: null };
}

/** Watermark for incremental runs: cursor of the last successful run of
 *  this job. Returns null on first run (caller picks a default window). */
export async function lastDoneCursor(job: string): Promise<string | null> {
  const { rows } = await getPool().query<{ c: string | null }>(
    `SELECT cursor_ts AS c FROM job_runs
      WHERE job = $1 AND status = 'done' AND cursor_ts IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`,
    [job],
  );
  return rows[0]?.c ?? null;
}

/** Progress heartbeat mid-run — processed/failed/cursor visible live. */
export async function updateJob(
  id: string,
  patch: { processed?: number; failed?: number; cursorTs?: string },
): Promise<void> {
  await getPool().query(
    `UPDATE job_runs SET
       processed  = COALESCE($2, processed),
       failed     = COALESCE($3, failed),
       cursor_ts  = COALESCE($4, cursor_ts)
     WHERE id = $1`,
    [id, patch.processed ?? null, patch.failed ?? null, patch.cursorTs ?? null],
  );
}

export async function finishJob(
  id: string,
  result: {
    processed?: number;
    failed?: number;
    cursorTs?: string;
    error?: string;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE job_runs SET
       status      = $2,
       finished_at = now(),
       processed   = COALESCE($3, processed),
       failed      = COALESCE($4, failed),
       cursor_ts   = COALESCE($5, cursor_ts),
       error       = $6
     WHERE id = $1`,
    [
      id,
      result.error ? "failed" : "done",
      result.processed ?? null,
      result.failed ?? null,
      result.cursorTs ?? null,
      result.error ?? null,
    ],
  );
}
