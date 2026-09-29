/* R7.1d.2 — production event-materiality pipeline. SHADOW ONLY.
 *
 * R7.1d.2 IS SHADOW DATA. DO NOT USE FOR USER-FACING RANKING.
 * Nothing in app/ may read these tables yet — the benchmark measured
 * honest but immature transmission quality (driver recall 0.43, target
 * recall 0.39); persistence exists to observe production behaviour.
 *
 * Event materiality is a PROJECTION of claim_materiality_current —
 * never a second truth system, never a re-score of event text:
 *
 *   events → claims → claim_materiality_current → assessments
 *                        ↓ aggregateClaimsToEvent()
 *              event_materiality_assessments (append-only)
 *                        ↓ CAS on source_generation
 *              event_materiality_current
 *
 * Persistence is generation-safe AND set-consistent:
 *   dirty_events(job='event_materiality') carries generation (0040).
 *   Publish + ack are ONE transaction: verify the dirty row's
 *   generation is still ours, RE-READ the current claim-assessment
 *   set inside the transaction and recompute input_hash — a set that
 *   changed without a queue bump (bug/manual SQL) still fails the CAS
 *   and rolls back. Then insert-or-reuse the assessment and CAS the
 *   projection. Any staleness → ROLLBACK → the newer unit stays pending.
 *
 * Producer side: publishClaimAssessment enqueues the parent event in
 * the SAME transaction as the claim projection update, but only when
 * the projection's assessment_id actually changed — a generation bump
 * that replays to the same assessment mints no event work.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { getPool, toJsonb } from "./pool";
import {
  enqueueDirty,
  finishJob,
  pendingDirtyEvents,
  startJob,
  updateJob,
  type DirtyWork,
} from "./jobs";
import {
  aggregateClaimsToEvent,
  type ClaimMaterialityAssessment,
  type EventClaimAggregation,
} from "../materiality-claims";

export const EVENT_DIRTY_JOB = "event_materiality";
export const EVENT_JOB_RUN = "event-materiality";

/* ── canonical input builder ────────────────────────────────── */

/** One claim's contribution to its event: identity + the CURRENT
 *  persisted assessment. The event worker never re-scores claims. */
export interface EventClaimRef {
  claimId: string;
  assessmentId: string;
  assessment: ClaimMaterialityAssessment;
}

export interface EventMaterialityInput {
  eventId: string;
  /** sorted by claimId — canonical order feeds both hash and snapshot */
  claims: EventClaimRef[];
}

/** Load the canonical aggregation input: the event's claims joined to
 *  their CURRENT materiality projections. Shared by corpus dump and
 *  production worker — an input that differs between them is a
 *  provenance bug, not a portability detail. Events with no assessed
 *  claims still return a row (empty claims → none aggregation). */
export async function loadEventMaterialityInputs(
  eventIds: string[],
  client: pg.Pool | pg.PoolClient = getPool(),
): Promise<Map<string, EventMaterialityInput>> {
  const out = new Map<string, EventMaterialityInput>();
  if (!eventIds.length) return out;
  for (const id of eventIds) out.set(id, { eventId: id, claims: [] });
  const ph = eventIds.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await client.query<{
    event_id: string;
    claim_id: string;
    assessment_id: string;
    assessment: ClaimMaterialityAssessment;
  }>(
    `SELECT c.event_id, c.id AS claim_id,
            p.assessment_id, a.assessment
       FROM claims c
       JOIN claim_materiality_current p ON p.claim_id = c.id
       JOIN claim_materiality_assessments a ON a.id = p.assessment_id
      WHERE c.event_id IN (${ph})
      ORDER BY c.event_id, c.id`,
    eventIds,
  );
  for (const r of rows) {
    out.get(r.event_id)?.claims.push({
      claimId: r.claim_id,
      assessmentId: r.assessment_id,
      assessment: r.assessment,
    });
  }
  return out;
}

/* ── input hash ─────────────────────────────────────────────── */

/* Semantic hash of the claim→assessment SET ONLY. Event title, topic,
 * timestamps, queue generation and run ids are deliberately excluded:
 * a headline edit that changes no claim assessment must not mint a new
 * event assessment; an identical claim set under a different
 * generation MUST hash identically. */
export function eventInputHash(input: EventMaterialityInput): string {
  const refs = input.claims.map((c) => `${c.claimId}:${c.assessmentId}`).sort();
  return createHash("sha256").update(refs.join("\n")).digest("hex");
}

/* ── persistence — append-only assessment + CAS projection ──── */

export type EventPublishResult =
  | { status: "published"; assessmentId: string; reused: boolean }
  | { status: "skipped" } // event no longer live — work consumed
  | { status: "stale" };

/** Publish one aggregated unit of work. The ENTIRE conditional write
 *  is a single transaction: event still live → ack the exact dirty
 *  generation → re-read the live claim-assessment set and CAS on its
 *  hash → insert-or-reuse → CAS projection. Staleness rolls back and
 *  the pending row survives for retry. */
export async function publishEventAssessment(
  work: DirtyWork,
  input: EventMaterialityInput,
  aggregation: EventClaimAggregation,
): Promise<EventPublishResult> {
  const c = await getPool().connect();
  const inputHash = eventInputHash(input);
  try {
    await c.query("BEGIN");

    // 1) event must still be live — a merged/archived event has no
    //    live processing; the unit is consumed so the queue stays clean
    const { rows: ev } = await c.query<{ status: string }>(
      `SELECT status::text AS status FROM events WHERE id = $1 FOR UPDATE`,
      [work.eventId],
    );
    if (!ev[0] || ev[0].status === "merged" || ev[0].status === "archived") {
      await c.query(
        `UPDATE dirty_events SET processed_at = now()
          WHERE event_id = $1 AND job = $2 AND generation = $3`,
        [work.eventId, EVENT_DIRTY_JOB, work.generation],
      );
      await c.query("COMMIT");
      return { status: "skipped" };
    }

    // 2) ack the EXACT generation we read — a producer re-enqueue since
    //    then bumps generation, so this updates 0 rows when stale
    const { rowCount: acked } = await c.query(
      `UPDATE dirty_events SET processed_at = now()
        WHERE event_id = $1 AND job = $2 AND generation = $3
          AND processed_at IS NULL`,
      [work.eventId, EVENT_DIRTY_JOB, work.generation],
    );
    if (!acked) {
      await c.query("ROLLBACK");
      return { status: "stale" };
    }

    // 3) set-CAS: re-read the CURRENT claim→assessment set inside the
    //    transaction. Queue generation alone cannot catch a producer
    //    that forgot to enqueue — the semantic hash is the authority.
    const { rows: live } = await c.query<{
      claim_id: string;
      assessment_id: string;
    }>(
      `SELECT c.id AS claim_id, p.assessment_id
         FROM claims c
         JOIN claim_materiality_current p ON p.claim_id = c.id
        WHERE c.event_id = $1
        ORDER BY c.id`,
      [work.eventId],
    );
    const liveHash = createHash("sha256")
      .update(
        live
          .map((r) => `${r.claim_id}:${r.assessment_id}`)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    if (liveHash !== inputHash) {
      await c.query("ROLLBACK");
      return { status: "stale" };
    }

    // 4) append-only assessment — same claim set + same method+version
    //    reuses the existing row instead of duplicating
    const key = [work.eventId, aggregation.methodVersion, inputHash];
    const { rows: ex } = await c.query<{ id: string }>(
      `SELECT id FROM event_materiality_assessments
        WHERE event_id = $1 AND method_version = $2 AND input_hash = $3`,
      key,
    );
    let assessmentId = ex[0]?.id;
    const reused = !!assessmentId;
    if (!assessmentId) {
      const { rows: ins } = await c.query<{ id: string }>(
        `INSERT INTO event_materiality_assessments
           (event_id, input_hash, input_snapshot, method, method_version,
            intrinsic_materiality, scope, confidence, channels,
            affected_targets, driver_claim_ids, contributing_claim_ids,
            claim_assessment_ids, coverage, cautions, assessment)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,
                 $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
                 $16::jsonb)
         ON CONFLICT (event_id, method_version, input_hash) DO NOTHING
         RETURNING id`,
        [
          work.eventId,
          inputHash,
          JSON.stringify(input),
          aggregation.method,
          aggregation.methodVersion,
          aggregation.materiality,
          aggregation.scope,
          aggregation.confidence,
          toJsonb(aggregation.channels),
          toJsonb(aggregation.affectedTargets),
          toJsonb(aggregation.driverClaimIds),
          toJsonb(aggregation.contributingClaimIds),
          toJsonb(input.claims.map((x) => x.assessmentId).sort()),
          toJsonb(aggregation.coverage),
          toJsonb(aggregation.cautions),
          JSON.stringify(aggregation),
        ],
      );
      assessmentId = ins[0]?.id;
      // belt: an interleaved same-key insert wins; reuse its row
      if (!assessmentId) {
        const { rows: again } = await c.query<{ id: string }>(
          `SELECT id FROM event_materiality_assessments
            WHERE event_id = $1 AND method_version = $2
              AND input_hash = $3`,
          key,
        );
        assessmentId = again[0]?.id;
      }
    }
    if (!assessmentId) throw new Error("assessment insert+lookup both failed");

    // 5) CAS projection — a lower generation can never overwrite a
    //    higher one even if it somehow reached this point
    const { rowCount: projected } = await c.query(
      `UPDATE event_materiality_current SET
         assessment_id     = $2,
         input_hash        = $3,
         method_version    = $4,
         source_generation = $5,
         updated_at        = now()
       WHERE event_id = $1 AND source_generation <= $5`,
      [
        work.eventId,
        assessmentId,
        inputHash,
        aggregation.methodVersion,
        work.generation,
      ],
    );
    if (!projected)
      await c.query(
        `INSERT INTO event_materiality_current
           (event_id, assessment_id, input_hash, method_version,
            source_generation, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (event_id) DO NOTHING`,
        [
          work.eventId,
          assessmentId,
          inputHash,
          aggregation.methodVersion,
          work.generation,
        ],
      );

    await c.query("COMMIT");
    return { status: "published", assessmentId, reused };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/* ── claim → event atomic handoff ───────────────────────────── */

/** Producer hook — call INSIDE the transaction that just moved a
 *  claim's materiality projection. Dirties the parent event only when
 *  the projection's assessment_id actually changed: null→A on first
 *  publish and A→B on a semantic change dirty the event, while a
 *  generation bump that replays to the same assessment mints nothing. */
export async function enqueueEventOnClaimAssessmentChange(
  client: pg.PoolClient,
  claimId: string,
  prevAssessmentId: string | null,
  nextAssessmentId: string,
): Promise<void> {
  if (prevAssessmentId === nextAssessmentId) return;
  const { rows } = await client.query<{ event_id: string }>(
    `SELECT event_id FROM claims WHERE id = $1`,
    [claimId],
  );
  if (!rows[0]) return;
  await enqueueDirty(
    client,
    rows[0].event_id,
    EVENT_DIRTY_JOB,
    "claim_materiality_changed",
  );
}

/* ── worker ─────────────────────────────────────────────────── */

export interface EventDrainResult {
  processed: number;
  assessmentsInserted: number;
  assessmentsReused: number;
  projectionUpdated: number;
  staleGeneration: number;
  failed: number;
  /* dirty rows still unprocessed when the run ended — a run that hit
   * the pass bound or persistent failures reports honestly instead of
   * looking fully drained */
  pendingRemaining: number;
  runId: string;
}

/** Drain the event-materiality queue. Discovery is queue-only — every
 *  pending row is re-read each pass so a generation bumped mid-flight
 *  is re-processed in its NEW generation, not skipped. */
export async function drainEventMateriality(
  opts: {
    metadata?: Record<string, unknown>;
  } = {},
): Promise<EventDrainResult> {
  const run = await startJob(EVENT_JOB_RUN, opts.metadata ?? {});
  const r: EventDrainResult = {
    processed: 0,
    assessmentsInserted: 0,
    assessmentsReused: 0,
    projectionUpdated: 0,
    staleGeneration: 0,
    failed: 0,
    pendingRemaining: 0,
    runId: run.id,
  };
  try {
    /* bounded passes: each pass re-reads pending so a re-enqueued
     * generation is handled in the same drain; the bound prevents a
     * pathological producer from starving the worker forever */
    for (let pass = 0; pass < 20; pass++) {
      const pending = await pendingDirtyEvents(EVENT_DIRTY_JOB);
      if (!pending.length) break;
      const inputs = await loadEventMaterialityInputs(
        pending.map((p) => p.eventId),
      );
      let progress = 0;
      let staleThisPass = 0;
      for (const work of pending) {
        const row = inputs.get(work.eventId);
        if (!row) {
          r.failed++;
          continue;
        }
        try {
          const aggregation = aggregateClaimsToEvent(
            row.claims.map((x) => x.assessment),
          );
          const res = await publishEventAssessment(work, row, aggregation);
          if (res.status === "stale") {
            r.staleGeneration++;
            staleThisPass++;
            continue;
          }
          r.processed++;
          progress++;
          if (res.status === "published") {
            if (res.reused) r.assessmentsReused++;
            else r.assessmentsInserted++;
            r.projectionUpdated++;
          }
        } catch (err) {
          r.failed++;
          console.error(
            `event-materiality ${work.eventId}:`,
            (err as Error).message,
          );
        }
      }
      await updateJob(run.id, { processed: r.processed, failed: r.failed });
      /* no progress AND nothing stale ⇒ remaining rows are deterministic
       * failures a re-read can't fix → stop. stale-without-progress means
       * a producer bumped a generation mid-pass → loop so this SAME run
       * drains the newer generation rather than leaving it for next time */
      if (!progress && !staleThisPass) break;
    }
    r.pendingRemaining = (await pendingDirtyEvents(EVENT_DIRTY_JOB)).length;
    await finishJob(run.id, { processed: r.processed, failed: r.failed });
  } catch (err) {
    await finishJob(run.id, {
      processed: r.processed,
      failed: r.failed + 1,
      error: (err as Error).message,
    });
    throw err;
  }
  return r;
}
