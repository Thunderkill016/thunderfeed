/* job_runs — observable cron jobs (0037/0038). Every batch pass (enrich,
 * adjudicate, relineage…) records: who ran, when, how far it got, what
 * failed. A run that dies at 3000/6000 leaves status='running' with the
 * cursor where it stopped — resumable, and visible without guessing.
 *
 * Cursor correctness: the watermark only covers the CONTIGUOUS
 * SUCCESSFUL PREFIX of the sweep — a failed event can never be jumped
 * over and lost. A run with per-event failures lands 'partial' (work
 * committed up to the cursor is real) rather than 'done'; the next run
 * resumes from the cursor and retries exactly the failed events.
 * A 'running' row left by a dead process is marked stale when the next
 * run starts, so crashed runs surface instead of pretending liveness.
 *
 *   const run = await startJob("enrich", { mode: "incremental" });
 *   const since = opts.since ?? await lastDoneCursor("enrich");
 *   ... per-event work; on failure: failedIds.add(e.id)
 *   await finishJob(run.id, { processed, failed, cursorTs: checkpointCursor(...) });
 */
import type pg from "pg";
import { getPool } from "./pool";

/** a 'running' row older than this was abandoned by a dead process */
export const STALE_RUN_MINUTES = 30;

export interface JobRun {
  id: string;
  cursorTs: string | null;
}

export async function startJob(
  job: string,
  metadata: Record<string, unknown> = {},
): Promise<JobRun> {
  const pool = getPool();
  /* recover stale runners: this new run is proof the old one is dead */
  await pool.query(
    `UPDATE job_runs SET status='failed', finished_at=now(),
            error='stale: superseded — runner died without finishing'
      WHERE job=$1 AND status='running'
        AND started_at < now() - interval '${STALE_RUN_MINUTES} minutes'`,
    [job],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_runs (job, status, metadata) VALUES ($1, 'running', $2)
     RETURNING id`,
    [job, JSON.stringify(metadata)],
  );
  return { id: rows[0].id, cursorTs: null };
}

/** Watermark for incremental runs: cursor of the last run that committed
 *  work ('done' or 'partial' — a partial run's cursor is still a valid
 *  contiguous-success watermark). Returns null on first run. */
export async function lastDoneCursor(job: string): Promise<string | null> {
  const { rows } = await getPool().query<{ c: string | null }>(
    `SELECT cursor_ts AS c FROM job_runs
      WHERE job = $1 AND status IN ('done','partial') AND cursor_ts IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`,
    [job],
  );
  return rows[0]?.c ?? null;
}

/**
 * The cursor may only advance over a contiguous successful prefix.
 * `events` must be in processing order (asc last_seen_at); the first
 * failed id freezes the watermark there — later successes still commit
 * but stay behind the cursor so the next run re-examines them.
 */
export function checkpointCursor(
  events: { id: string; lastSeenAt: string }[],
  failedIds: ReadonlySet<string>,
  fallback: string,
): string {
  let cursor = fallback;
  for (const e of events) {
    if (failedIds.has(e.id)) break;
    cursor = e.lastSeenAt;
  }
  return cursor;
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
  const status = result.error
    ? "failed"
    : (result.failed ?? 0) > 0
      ? "partial"
      : "done";
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
      status,
      result.processed ?? null,
      result.failed ?? null,
      result.cursorTs ?? null,
      result.error ?? null,
    ],
  );
}

/* ── dirty_events — durable producer→consumer hand-off ────────────────
 *
 * A producer (e.g. relineage) that mutates evidence for an OLD event must
 * not rely on the consumer's timestamp cursor to rediscover it. Enqueue
 * inside the SAME transaction as the dirtying write — the hand-off then
 * commits atomically with the work, and a re-enqueue resets
 * processed_at so a later consumer run retries it.
 */
export async function enqueueDirty(
  client: pg.PoolClient | pg.Pool,
  eventId: string,
  job: string,
  reason: string,
): Promise<void> {
  /* re-enqueue is a NEW unit of work: generation+1 invalidates every
   * ack token a consumer may still be holding for the older read */
  await client.query(
    `INSERT INTO dirty_events (event_id, job, reason, generation)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (event_id, job)
     DO UPDATE SET processed_at = NULL, reason = $3, queued_at = now(),
                   generation = dirty_events.generation + 1`,
    [eventId, job, reason],
  );
}

/** One pending unit of work — the ack token is (eventId, generation). */
export interface DirtyWork {
  eventId: string;
  generation: number;
}

/** Pending work for a consumer job — live events only. */
export async function pendingDirtyEvents(job: string): Promise<DirtyWork[]> {
  const { rows } = await getPool().query<{
    event_id: string;
    generation: number;
  }>(
    `SELECT d.event_id, d.generation::int AS generation FROM dirty_events d
       JOIN events e ON e.id = d.event_id
      WHERE d.job = $1 AND d.processed_at IS NULL
        AND e.status NOT IN ('merged','archived')
      ORDER BY d.queued_at`,
    [job],
  );
  return rows.map((r) => ({ eventId: r.event_id, generation: r.generation }));
}

/** Acknowledge the EXACT unit that was read — returns false when a newer
 * generation exists (someone re-dirtied the event mid-flight), in which
 * case nothing is acked and the pending row survives for retry. */
export async function markDirtyDone(
  eventId: string,
  job: string,
  generation: number,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE dirty_events SET processed_at = now()
      WHERE event_id = $1 AND job = $2 AND generation = $3
        AND processed_at IS NULL`,
    [eventId, job, generation],
  );
  return (rowCount ?? 0) > 0;
}

/* ── dirty_claims — generation-safe claim queue (R7.1c) ──────────────
 *
 * Same contract as dirty_events but generation exists from day one:
 * re-enqueue bumps generation, so a consumer's generation-bound ack can
 * never retire a unit of work it never saw. Producers enqueue INSIDE the
 * transaction that dirtied the claim — the hand-off commits atomically
 * with the work. */
export async function enqueueDirtyClaim(
  client: pg.PoolClient | pg.Pool,
  claimId: string,
  job: string,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO dirty_claims (claim_id, job, reason, generation)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (claim_id, job)
     DO UPDATE SET processed_at = NULL, reason = $3, queued_at = now(),
                   generation = dirty_claims.generation + 1`,
    [claimId, job, reason],
  );
}

/** One pending unit of claim work — the ack token is (claimId, generation). */
export interface DirtyClaimWork {
  claimId: string;
  generation: number;
}

export async function pendingDirtyClaims(
  job: string,
): Promise<DirtyClaimWork[]> {
  const { rows } = await getPool().query<{
    claim_id: string;
    generation: number;
  }>(
    `SELECT claim_id, generation::int AS generation FROM dirty_claims
      WHERE job = $1 AND processed_at IS NULL
      ORDER BY queued_at`,
    [job],
  );
  return rows.map((r) => ({ claimId: r.claim_id, generation: r.generation }));
}

/** Acknowledge the EXACT unit read — false when a newer generation
 *  exists (the pending row survives for the next drain). */
export async function markDirtyClaimDone(
  claimId: string,
  job: string,
  generation: number,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE dirty_claims SET processed_at = now()
      WHERE claim_id = $1 AND job = $2 AND generation = $3
        AND processed_at IS NULL`,
    [claimId, job, generation],
  );
  return (rowCount ?? 0) > 0;
}
