/* R7.1c — production claim-materiality pipeline.
 *
 * One canonical input builder feeds BOTH the frozen corpus dump and the
 * production worker, so a benchmarked input is byte-identical to a scored
 * one. Truth semantics are never re-implemented here: provenance runs the
 * exact R6 chain — all claim_versions → claim_evidence → lineage-root
 * voter (resolveOriginSources) → latestVotes → positionsFromVotes →
 * standingClaimPos (mutable = rankWinner, protected = current position)
 * → live standing docs → latestLineage + effectiveRoots.
 *
 * Persistence is generation-safe:
 *   dirty_claims carries generation from day one (R6.1d applied at
 *   birth). Publish + ack are ONE transaction: verify the dirty row's
 *   generation is still ours AND claims.current_version_id still equals
 *   the input we scored, insert-or-reuse the assessment, CAS the
 *   projection (never overwrite a higher source_generation), then ack.
 *   Any staleness → ROLLBACK → the newer unit stays pending.
 *
 * job_runs is observability only — work discovery is queue-driven, never
 * a timestamp cursor.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { getPool } from "./pool";
import { effectiveRoots, latestLineage } from "./read";
import { standingEvidenceByClaim } from "./adjudicate";
import { finishJob, pendingDirtyClaims, startJob, updateJob } from "./jobs";
import { enqueueEventOnClaimAssessmentChange } from "./event-materiality";
import {
  scoreClaimMateriality,
  type ClaimMaterialityAssessment,
  type ClaimMaterialityInput,
  type ClaimState,
} from "../materiality-claims";

export const MATERIALITY_JOB = "materiality";

/* ── canonical input builder ────────────────────────────────── */

export interface ClaimEvidenceStats {
  confirmedIndependentOrigins: number;
  primaryOrigins: number;
  unresolvedOrigins: number;
  derivedDocuments: number;
  rawSourceCount: number;
}

export interface ClaimMaterialityRow {
  claimId: string;
  eventId: string;
  input: ClaimMaterialityInput;
}

/** Load the canonical scorer input for logical claims. Shared by the
 *  corpus dump and the production worker — an input that differs
 *  between them is a provenance bug, not a portability detail. */
export async function loadClaimMaterialityInputs(
  claimIds: string[],
  client: pg.Pool | pg.PoolClient = getPool(),
): Promise<Map<string, ClaimMaterialityRow>> {
  const out = new Map<string, ClaimMaterialityRow>();
  if (!claimIds.length) return out;
  const ph = claimIds.map((_, i) => `$${i + 1}`).join(",");

  const { rows } = await client.query<{
    claim_id: string;
    event_id: string;
    predicate: string;
    claim_type: string | null;
    subject_entity_id: string | null;
    version_id: string;
    value: unknown;
    value_type: string | null;
    unit: string | null;
    qualifiers: Record<string, unknown> | null;
    state: ClaimState;
    valid_from: string | Date | null;
    prev_version_id: string | null;
    prev_value: unknown;
    prev_unit: string | null;
    prev_state: string | null;
  }>(
    `SELECT c.id AS claim_id, c.event_id, c.predicate, c.claim_type,
            c.subject_entity_id,
            cv.id AS version_id, cv.value, cv.value_type, cv.unit,
            cv.qualifiers, cv.state::text AS state, cv.valid_from,
            pv.id AS prev_version_id, pv.value AS prev_value,
            pv.unit AS prev_unit, pv.state::text AS prev_state
       FROM claims c
       JOIN claim_versions cv ON cv.id = c.current_version_id
       LEFT JOIN claim_versions pv ON pv.id = cv.previous_version_id
      WHERE c.id IN (${ph})`,
    claimIds,
  );
  if (!rows.length) return out;

  const statsMap = await claimEvidenceStats(
    rows.map((r) => r.claim_id),
    client,
  );

  for (const r of rows) {
    const ev = statsMap.get(r.claim_id);
    out.set(r.claim_id, {
      claimId: r.claim_id,
      eventId: r.event_id,
      input: {
        claimId: r.claim_id,
        predicate: r.predicate,
        claimType: r.claim_type,
        current: {
          versionId: r.version_id,
          value: r.value,
          valueType: r.value_type,
          unit: r.unit,
          qualifiers: r.qualifiers,
          state: r.state,
          // normalized to ISO so pg and pg-mem produce identical input
          validFrom: r.valid_from ? new Date(r.valid_from).toISOString() : null,
        },
        /* truth history ONLY — previous_version_id is the prior truth
         * state of the same proposition, never the prior economic
         * period. Prod binds no structured from→to yet:
         * economicComparison stays null until a real comparison source
         * exists; rates/tariffs/profits score as level observations. */
        previousVersion: r.prev_version_id
          ? {
              versionId: r.prev_version_id,
              value: r.prev_value,
              unit: r.prev_unit,
              state: r.prev_state,
            }
          : null,
        economicComparison: null,
        subject: {
          /* prod: subject_entity_id is never bound yet, so canonicalKey/
           * type/countryCode stay null and qualifier text carries the
           * load. When entity binding lands, extend THIS builder — the
           * corpus and the worker move together. */
          entityId: r.subject_entity_id,
          canonicalKey: null,
          type: null,
          countryCode: null,
          qualifierText: (r.qualifiers?.subject as string | undefined) ?? null,
        },
        evidence: {
          claimState: r.state,
          confirmedIndependentOrigins: ev?.confirmedIndependentOrigins ?? 0,
          primaryOrigins: ev?.primaryOrigins ?? 0,
          unresolvedOrigins: ev?.unresolvedOrigins ?? 0,
          derivedDocuments: ev?.derivedDocuments ?? 0,
          rawSourceCount: ev?.rawSourceCount ?? 0,
        },
      },
    });
  }
  return out;
}

/* Evidence stats at the LOGICAL CLAIM grain. Mirrors the batch
 * adjudicator's vote construction exactly — same voter identity
 * (lineage-root source), same ordering (latestVotes by evidence time),
 * same winner rule (standingClaimPos), same primary flag
 * (evidence_strength='direct'). */
async function claimEvidenceStats(
  claimIds: string[],
  client: pg.Pool | pg.PoolClient,
): Promise<Map<string, ClaimEvidenceStats>> {
  const out = new Map<string, ClaimEvidenceStats>();
  if (!claimIds.length) return out;

  /* standing evidence = the shared canonical accessor (adjudicate.ts) —
   * latest vote per origin restricted to the standing position. Same
   * derivation the batch adjudicator applies. */
  const standingMap = await standingEvidenceByClaim(client, claimIds);

  /* lineage closure over every touched doc AND its ancestors — a root
   * outside the doc set must resolve, not count dangling */
  const evDocIds = [
    ...new Set([...standingMap.values()].flatMap((s) => s.allDocIds)),
  ];
  const edges = new Map<string, { parent: string | null; relation: string }>();
  let frontier = evDocIds;
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const lin = await latestLineage(frontier);
    const next = new Set<string>();
    for (const [child, e] of lin) {
      edges.set(child, e);
      if (e.parent && !edges.has(e.parent)) next.add(e.parent);
    }
    frontier = [...next];
  }
  const touchedIds = new Set(evDocIds);
  for (const e of edges.values()) if (e.parent) touchedIds.add(e.parent);
  let docMeta: { doc_id: string; source_id: string; kind: string }[] = [];
  if (touchedIds.size) {
    const tph = [...touchedIds].map((_, i) => `$${i + 1}`).join(",");
    ({ rows: docMeta } = await client.query<{
      doc_id: string;
      source_id: string;
      kind: string;
    }>(
      `SELECT ed.id AS doc_id, ed.source_id, s.kind::text AS kind
         FROM evidence_documents ed
         JOIN sources s ON s.id = ed.source_id
        WHERE ed.id IN (${tph})`,
      [...touchedIds],
    ));
  }
  const known = new Map(docMeta.map((d) => [d.doc_id, d]));

  for (const [claimId, se] of standingMap) {
    // live standing docs = docs behind each voter's latest vote,
    // restricted to votes standing on the standing position — a source
    // whose latest assertion moved elsewhere no longer counts here
    const standingDocs = [...new Set(se.standing.map((r) => r.docId))]
      .map((id) => known.get(id))
      .filter((d): d is NonNullable<typeof d> => d != null);
    const stats = effectiveRoots(standingDocs, edges, known);
    out.set(claimId, {
      confirmedIndependentOrigins: stats.confirmedIndependentOrigins,
      primaryOrigins: stats.primaryOrigins,
      unresolvedOrigins: stats.unresolvedOrigins,
      derivedDocuments: stats.derivedDocuments,
      rawSourceCount: new Set(standingDocs.map((d) => d.source_id)).size,
    });
  }
  return out;
}

/* ── input hash ─────────────────────────────────────────────── */

/* Stable key-sorted JSON — hash input = semantic content, never record
 * identity (claim_id / version ids), timestamps, queue metadata or run
 * ids. Same content under a different generation MUST hash identically;
 * a provenance-only change MUST hash differently. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function claimInputHash(input: ClaimMaterialityInput): string {
  const { claimId: _c, current, previousVersion, ...rest } = input;
  const { versionId: _v, ...currentSem } = current;
  const { versionId: _pv, ...prevSem } = previousVersion ?? {};
  return createHash("sha256")
    .update(
      canonicalJson({
        ...rest,
        current: currentSem,
        previousVersion: previousVersion ? prevSem : null,
      }),
    )
    .digest("hex");
}

/* ── persistence — append-only assessment + CAS projection ──── */

export type PublishResult =
  | { status: "published"; assessmentId: string; reused: boolean }
  | { status: "stale" };

/** Publish one scored unit of work. The ENTIRE conditional write is a
 *  single transaction: a stale generation or a moved current version
 *  rolls back cleanly and the pending row survives for retry. */
export async function publishClaimAssessment(
  work: { claimId: string; generation: number },
  input: ClaimMaterialityInput,
  assessment: ClaimMaterialityAssessment,
): Promise<PublishResult> {
  const c = await getPool().connect();
  const inputHash = claimInputHash(input);
  try {
    await c.query("BEGIN");

    // 1) the truth we scored must still be the live truth
    const { rows: cur } = await c.query<{ v: string }>(
      `SELECT current_version_id AS v FROM claims WHERE id = $1`,
      [work.claimId],
    );
    if (cur[0]?.v !== input.current.versionId) {
      await c.query("ROLLBACK");
      return { status: "stale" };
    }

    // 2) ack the EXACT generation we read — a producer re-enqueue since
    //    then bumps generation, so this updates 0 rows when stale
    const { rowCount: acked } = await c.query(
      `UPDATE dirty_claims SET processed_at = now()
        WHERE claim_id = $1 AND job = $2 AND generation = $3
          AND processed_at IS NULL`,
      [work.claimId, MATERIALITY_JOB, work.generation],
    );
    if (!acked) {
      await c.query("ROLLBACK");
      return { status: "stale" };
    }

    // 3) append-only assessment — same input+method+version reuses the
    //    existing row instead of duplicating. Reuse is probed BEFORE
    //    insert: the dirty-row ack already serializes publishers for
    //    this claim, and a pre-read distinguishes reuse from insert
    //    without leaning on INSERT...RETURNING semantics.
    const key = [
      work.claimId,
      input.current.versionId,
      assessment.methodVersion,
      inputHash,
    ];
    const { rows: ex } = await c.query<{ id: string }>(
      `SELECT id FROM claim_materiality_assessments
        WHERE claim_id = $1 AND claim_version_id = $2
          AND method_version = $3 AND input_hash = $4`,
      key,
    );
    let assessmentId = ex[0]?.id;
    const reused = !!assessmentId;
    if (!assessmentId) {
      const { rows: ins } = await c.query<{ id: string }>(
        `INSERT INTO claim_materiality_assessments
           (claim_id, claim_version_id, input_hash, input_snapshot,
            method, method_version, action_type, intrinsic_materiality,
            scope, transmission_confidence, excluded, assessment)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (claim_id, claim_version_id, method_version, input_hash)
         DO NOTHING
         RETURNING id`,
        [
          work.claimId,
          input.current.versionId,
          inputHash,
          JSON.stringify(input),
          assessment.method,
          assessment.methodVersion,
          assessment.action.type,
          assessment.materiality,
          assessment.scope,
          assessment.transmissionConfidence,
          assessment.excluded,
          JSON.stringify(assessment),
        ],
      );
      assessmentId = ins[0]?.id;
      // belt: an interleaved same-key insert wins; reuse its row
      if (!assessmentId) {
        const { rows: again } = await c.query<{ id: string }>(
          `SELECT id FROM claim_materiality_assessments
            WHERE claim_id = $1 AND claim_version_id = $2
              AND method_version = $3 AND input_hash = $4`,
          key,
        );
        assessmentId = again[0]?.id;
      }
    }
    if (!assessmentId) throw new Error("assessment insert+lookup both failed");

    /* claim → event handoff (R7.1d.2): the parent event's input set is
     * (claim → current assessment) pairs, so it changes exactly when the
     * projection's assessment_id moves. Compare before/after INSIDE this
     * transaction and dirty the event atomically — a generation bump that
     * replays to the same assessment mints no event work. */
    const { rows: prevProj } = await c.query<{ a: string }>(
      `SELECT assessment_id AS a FROM claim_materiality_current
        WHERE claim_id = $1`,
      [work.claimId],
    );
    const prevAssessmentId = prevProj[0]?.a ?? null;

    // 4) CAS projection — a lower generation can never overwrite a
    //    higher one even if it somehow reached this point. The dirty-row
    //    ack above serializes publishers for this claim, so UPDATE-miss
    //    followed by INSERT...DO NOTHING is sufficient and portable.
    const { rowCount: projected } = await c.query(
      `UPDATE claim_materiality_current SET
         assessment_id     = $2,
         claim_version_id  = $3,
         input_hash        = $4,
         method_version    = $5,
         source_generation = $6,
         updated_at        = now()
       WHERE claim_id = $1 AND source_generation <= $6`,
      [
        work.claimId,
        assessmentId,
        input.current.versionId,
        inputHash,
        assessment.methodVersion,
        work.generation,
      ],
    );
    if (!projected)
      await c.query(
        `INSERT INTO claim_materiality_current
           (claim_id, assessment_id, claim_version_id, input_hash,
            method_version, source_generation, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (claim_id) DO NOTHING`,
        [
          work.claimId,
          assessmentId,
          input.current.versionId,
          inputHash,
          assessment.methodVersion,
          work.generation,
        ],
      );

    /* event dirty iff the projection's assessment actually moved. The
     * CAS above may have lost to a newer committed generation — re-read
     * the row post-write so we enqueue only on a real id transition
     * (null→A first publish, A→B semantic change; A→A replay: silent). */
    const { rows: nextProj } = await c.query<{ a: string }>(
      `SELECT assessment_id AS a FROM claim_materiality_current
        WHERE claim_id = $1`,
      [work.claimId],
    );
    if (nextProj[0] && nextProj[0].a !== prevAssessmentId) {
      await enqueueEventOnClaimAssessmentChange(
        c,
        work.claimId,
        prevAssessmentId,
        nextProj[0].a,
      );
    }

    await c.query("COMMIT");
    return { status: "published", assessmentId, reused };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/* ── worker ─────────────────────────────────────────────────── */

export interface DrainResult {
  processed: number;
  assessmentsInserted: number;
  assessmentsReused: number;
  projectionUpdated: number;
  staleGeneration: number;
  failed: number;
  /* dirty rows still unprocessed when the run ended — a run that hit the
   * pass bound or persistent failures reports honestly instead of
   * looking fully drained */
  pendingRemaining: number;
  runId: string;
}

/** Drain the claim-materiality queue. Discovery is queue-only — every
 *  pending row is re-read each pass so a generation bumped mid-flight
 *  is re-processed in its NEW generation, not skipped. */
export async function drainClaimMateriality(
  opts: {
    metadata?: Record<string, unknown>;
  } = {},
): Promise<DrainResult> {
  const run = await startJob("claim-materiality", opts.metadata ?? {});
  const r: DrainResult = {
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
      const pending = await pendingDirtyClaims(MATERIALITY_JOB);
      if (!pending.length) break;
      const inputs = await loadClaimMaterialityInputs(
        pending.map((p) => p.claimId),
      );
      let progress = 0;
      let staleThisPass = 0;
      for (const work of pending) {
        const row = inputs.get(work.claimId);
        if (!row) {
          r.failed++;
          continue;
        }
        try {
          const assessment = scoreClaimMateriality(row.input);
          const res = await publishClaimAssessment(work, row.input, assessment);
          if (res.status === "stale") {
            r.staleGeneration++;
            staleThisPass++;
            continue;
          }
          r.processed++;
          progress++;
          if (res.reused) r.assessmentsReused++;
          else r.assessmentsInserted++;
          r.projectionUpdated++;
        } catch (err) {
          r.failed++;
          console.error(
            `claim-materiality ${work.claimId}:`,
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
    r.pendingRemaining = (await pendingDirtyClaims(MATERIALITY_JOB)).length;
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
