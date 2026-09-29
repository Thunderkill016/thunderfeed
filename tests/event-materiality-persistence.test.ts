/**
 * R7.1d.2 persistence — generation-safe event-materiality pipeline on
 * pg-mem. Event materiality is a PROJECTION of claim_materiality_current
 * — the worker never re-scores claims. The load-bearing invariants:
 *
 *   - claim projection assessment_id transition dirties the parent
 *     event in the SAME transaction; a replayed assessment (same id)
 *     mints no event work
 *   - publish+ack are ONE transaction bound to (dirty generation AND
 *     the live claim-assessment set hash) — a stale worker publishes
 *     NOTHING and acks NOTHING
 *   - input-hash CAS: a claim set that changed without a queue bump
 *     still fails the in-transaction re-read
 *   - merged/archived events get no live processing
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import {
  enqueueDirty,
  enqueueDirtyClaim,
  pendingDirtyEvents,
} from "../lib/db/jobs";
import {
  drainClaimMateriality,
  loadClaimMaterialityInputs,
  publishClaimAssessment,
} from "../lib/db/claim-materiality";
import {
  drainEventMateriality,
  eventInputHash,
  loadEventMaterialityInputs,
  publishEventAssessment,
  EVENT_DIRTY_JOB,
} from "../lib/db/event-materiality";
import {
  aggregateClaimsToEvent,
  scoreClaimMateriality,
} from "../lib/materiality-claims";

function setupDb() {
  const db = newDb();
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n")
    .replace(
      /CREATE OR REPLACE FUNCTION uuid_v7[\s\S]*?LANGUAGE plpgsql VOLATILE;/,
      "",
    )
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/g, "");
  db.public.registerFunction({
    name: "uuid_v7",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  db.public.none(sql);
  const pg = db.adapters.createPg();
  injectPool(new pg.Pool() as unknown as Pool);
}

async function mkEvent(status = "emerging") {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO events (id, topic, status, first_seen_at, last_seen_at)
     VALUES ($1, 'world', $2::event_status, now(), now())`,
    [id, status],
  );
  return id;
}

async function mkClaim(
  eventId: string,
  value: unknown,
  predicate = "money_usd",
) {
  const claimId = randomUUID();
  await getPool().query(
    `INSERT INTO claims
       (id, event_id, claim_key, predicate, claim_type,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 'fact', now(), now())`,
    [claimId, eventId, `k-${claimId}`, predicate],
  );
  const versionId = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, state,
        observed_at, change_type, content_hash)
     VALUES ($1, $2, 1, 'number', $3::jsonb, 'usd', 'reported',
             now(), 'initial', $4)`,
    [versionId, claimId, JSON.stringify(value), `ch-${versionId}`],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [versionId, claimId],
  );
  return { claimId, versionId };
}

const q = async <T>(sql: string, params: unknown[]) =>
  (await getPool().query(sql, params)).rows as T[];

const eventAssessmentsOf = (eventId: string) =>
  q<{ id: string; input_hash: string; intrinsic_materiality: string }>(
    `SELECT id, input_hash, intrinsic_materiality
       FROM event_materiality_assessments WHERE event_id = $1
      ORDER BY assessed_at`,
    [eventId],
  );

const eventProjectionOf = (eventId: string) =>
  q<{ assessment_id: string; source_generation: number }>(
    `SELECT assessment_id, source_generation::int
       FROM event_materiality_current WHERE event_id = $1`,
    [eventId],
  );

const eventDirtyOf = (eventId: string) =>
  q<{ generation: number; processed_at: Date | null; reason: string }>(
    `SELECT generation::int AS generation, processed_at, reason
       FROM dirty_events
      WHERE event_id = $1 AND job = '${EVENT_DIRTY_JOB}'`,
    [eventId],
  );

/** push a claim through the claim pipeline (score+publish) inside the
 *  same generation the caller enqueued — the canonical producer path */
async function publishClaim(claimId: string, generation: number) {
  const input = (await loadClaimMaterialityInputs([claimId])).get(claimId)!;
  return publishClaimAssessment(
    { claimId, generation },
    input.input,
    scoreClaimMateriality(input.input),
  );
}

test("same claim-assessment set twice → one event assessment; replay reuses", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality(); // publishes claim + dirties event

  const r1 = await drainEventMateriality();
  assert.equal(r1.processed, 1);
  assert.equal(r1.assessmentsInserted, 1);
  assert.equal(r1.failed, 0);
  assert.equal((await eventAssessmentsOf(eventId)).length, 1);
  assert.equal((await eventProjectionOf(eventId)).length, 1);
  assert.equal((await pendingDirtyEvents(EVENT_DIRTY_JOB)).length, 0);

  // re-enqueue identical claim set → same input hash → reuse
  await enqueueDirty(getPool(), eventId, EVENT_DIRTY_JOB, "manual");
  const r2 = await drainEventMateriality();
  assert.equal(r2.assessmentsReused, 1);
  assert.equal(r2.assessmentsInserted, 0);
  assert.equal((await eventAssessmentsOf(eventId)).length, 1, "no dup");
});

test("claim assessment_id transition dirties parent event; replay does not", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  const p1 = await publishClaim(claimId, 1);
  assert.equal(p1.status, "published");
  // null → assessmentId: event dirtied in the same tx
  let d = (await eventDirtyOf(eventId))[0];
  assert.ok(d, "first claim publish must dirty the parent event");
  assert.equal(d.reason, "claim_materiality_changed");
  assert.equal(d.processed_at, null);

  await drainEventMateriality();
  assert.equal((await pendingDirtyEvents(EVENT_DIRTY_JOB)).length, 0);

  /* provenance-only churn: claim re-enqueued but replays to the SAME
   * assessment → projection assessment_id unchanged → NO event dirty */
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "relineage");
  const p2 = await publishClaim(claimId, 2);
  assert.equal(p2.status, "published");
  assert.equal(p2.reused, true, "identical input reuses assessment");
  assert.equal(
    (await pendingDirtyEvents(EVENT_DIRTY_JOB)).length,
    0,
    "same assessment_id must not cascade to the event",
  );

  /* semantic change: new claim_version (corrected value) → different
   * claim input → different assessment → event dirtied exactly once */
  const v2 = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, state,
        observed_at, previous_version_id, change_type, content_hash)
     VALUES ($1, $2, 2, 'number', '9000'::jsonb, 'usd', 'corrected',
             now(), $3, 'corrected', $4)`,
    [v2, claimId, versionId, `ch-${v2}`],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [v2, claimId],
  );
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "adjudicate");
  const p3 = await publishClaim(claimId, 3);
  assert.equal(p3.status, "published");
  const pend = await pendingDirtyEvents(EVENT_DIRTY_JOB);
  assert.equal(pend.length, 1, "semantic claim change dirties the event");
  assert.equal(
    (await eventDirtyOf(eventId))[0].reason,
    "claim_materiality_changed",
  );
});

test("event gen1 worker vs re-enqueued gen2 → gen1 cannot publish or ack", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality(); // event dirty gen1 pending

  const input = (await loadEventMaterialityInputs([eventId])).get(eventId)!;
  const agg = aggregateClaimsToEvent(input.claims.map((c) => c.assessment));
  // producer re-enqueues mid-flight → gen2
  await enqueueDirty(getPool(), eventId, EVENT_DIRTY_JOB, "relineage");

  const res = await publishEventAssessment(
    { eventId, generation: 1 },
    input,
    agg,
  );
  assert.equal(res.status, "stale");
  assert.equal((await eventAssessmentsOf(eventId)).length, 0);
  assert.equal((await eventProjectionOf(eventId)).length, 0);
  const d = (await eventDirtyOf(eventId))[0];
  assert.equal(d.generation, 2);
  assert.equal(d.processed_at, null, "gen2 stays pending");
});

test("gen2 publishes → stale gen1 finishes later → projection stays gen2", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality();

  const input = (await loadEventMaterialityInputs([eventId])).get(eventId)!;
  const agg = aggregateClaimsToEvent(input.claims.map((c) => c.assessment));
  await enqueueDirty(getPool(), eventId, EVENT_DIRTY_JOB, "relineage");

  const b = await publishEventAssessment(
    { eventId, generation: 2 },
    input,
    agg,
  );
  assert.equal(b.status, "published");
  const a = await publishEventAssessment(
    { eventId, generation: 1 },
    input,
    agg,
  );
  assert.equal(a.status, "stale");
  assert.equal((await eventProjectionOf(eventId))[0].source_generation, 2);
});

test("claim set changed without queue bump → in-tx hash CAS catches stale", async () => {
  setupDb();
  const eventId = await mkEvent();
  const c1 = await mkClaim(eventId, 500);
  const c2 = await mkClaim(eventId, 900);
  await enqueueDirtyClaim(getPool(), c1.claimId, "materiality", "ingest");
  await enqueueDirtyClaim(getPool(), c2.claimId, "materiality", "ingest");
  await drainClaimMateriality();
  // event dirty gen2 after both claim publishes
  await drainEventMateriality();
  assert.equal((await eventProjectionOf(eventId)).length, 1);

  /* simulate a producer bug: claim projection row updated directly
   * (no enqueue). Worker holds the OLD set; publish must fail the
   * in-transaction set-CAS even though the dirty generation matches. */
  const staleInput = (await loadEventMaterialityInputs([eventId])).get(
    eventId,
  )!;
  // point c1's projection at c2's assessment — same tx, no dirty bump
  const { rows: anyA } = await getPool().query<{ id: string }>(
    `SELECT id FROM claim_materiality_assessments
      WHERE claim_id = $1 LIMIT 1`,
    [c2.claimId],
  );
  await getPool().query(
    `UPDATE claim_materiality_current SET assessment_id = $2
      WHERE claim_id = $1`,
    [c1.claimId, anyA[0].id],
  );

  await enqueueDirty(getPool(), eventId, EVENT_DIRTY_JOB, "manual"); // gen3
  const agg = aggregateClaimsToEvent(
    staleInput.claims.map((c) => c.assessment),
  );
  const res = await publishEventAssessment(
    { eventId, generation: 3 },
    staleInput,
    agg,
  );
  assert.equal(res.status, "stale", "set-CAS must catch the silent drift");
  assert.equal((await eventDirtyOf(eventId))[0].generation, 3);
});

test("shuffled claim set → identical input hash and aggregation", async () => {
  setupDb();
  const eventId = await mkEvent();
  const c1 = await mkClaim(eventId, 500);
  const c2 = await mkClaim(eventId, 900);
  await enqueueDirtyClaim(getPool(), c1.claimId, "materiality", "ingest");
  await enqueueDirtyClaim(getPool(), c2.claimId, "materiality", "ingest");
  await drainClaimMateriality();

  const input = (await loadEventMaterialityInputs([eventId])).get(eventId)!;
  const shuffled = {
    eventId,
    claims: [...input.claims].reverse(),
  };
  assert.equal(eventInputHash(shuffled), eventInputHash(input));
  const a1 = aggregateClaimsToEvent(input.claims.map((c) => c.assessment));
  const a2 = aggregateClaimsToEvent(shuffled.claims.map((c) => c.assessment));
  assert.deepEqual(a2, a1);
});

test("merged/archived event → consumed without live processing", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality();
  // merge it AFTER the event dirty row exists
  await getPool().query(`UPDATE events SET status = 'merged' WHERE id = $1`, [
    eventId,
  ]);
  // pendingDirtyEvents already hides it — call publish directly with
  // the pre-merge read to prove the in-tx live check also guards
  const input = (await loadEventMaterialityInputs([eventId])).get(eventId)!;
  const agg = aggregateClaimsToEvent(input.claims.map((c) => c.assessment));
  const res = await publishEventAssessment(
    { eventId, generation: 1 },
    input,
    agg,
  );
  assert.equal(res.status, "skipped");
  assert.equal(
    (await eventAssessmentsOf(eventId)).length,
    0,
    "no assessment for a dead event",
  );
  assert.equal((await eventDirtyOf(eventId))[0].processed_at !== null, true);
});

test("dirty job isolation: event worker never consumes other jobs' rows", async () => {
  setupDb();
  const eventId = await mkEvent();
  // a pending row for a DIFFERENT job on the same event
  await enqueueDirty(getPool(), eventId, "adjudicate", "relineage");
  const r = await drainEventMateriality();
  assert.equal(r.processed, 0);
  const still = await q<{ generation: number }>(
    `SELECT generation::int AS generation FROM dirty_events
      WHERE event_id = $1 AND job = 'adjudicate' AND processed_at IS NULL`,
    [eventId],
  );
  assert.equal(still.length, 1, "other job's pending row untouched");
});

test("stale-only pass → re-reads and drains newer generation same run", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim(eventId, 500);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality();

  /* deterministic mid-flight producer: after the pending read resolves,
   * bump generation → pass 1 publish goes stale → loop must drain gen2
   * in the SAME run */
  const pool = getPool();
  type QFn = (sql: string, params?: unknown[]) => Promise<unknown>;
  const origQuery = pool.query.bind(pool) as unknown as QFn;
  let bumped = false;
  const patched: QFn = async (sql, params) => {
    const res = await origQuery(sql, params);
    if (!bumped && sql.includes("FROM dirty_events")) {
      bumped = true;
      await origQuery(
        `UPDATE dirty_events
           SET generation = generation + 1, processed_at = NULL
         WHERE event_id = $1 AND job = '${EVENT_DIRTY_JOB}'`,
        [eventId],
      );
    }
    return res;
  };
  (pool as { query: unknown }).query = patched;
  try {
    const r = await drainEventMateriality();
    assert.equal(r.staleGeneration, 1, "pass 1 went stale");
    assert.equal(r.processed, 1, "pass 2 drained gen2 same run");
    assert.equal(r.pendingRemaining, 0);
    assert.equal((await eventProjectionOf(eventId))[0].source_generation, 2);
  } finally {
    (pool as { query: unknown }).query = origQuery;
  }
});

test("end-to-end: claim change cascades event → aggregation reflects new set", async () => {
  setupDb();
  const eventId = await mkEvent();
  const small = await mkClaim(eventId, 500);
  const big = await mkClaim(eventId, 30_000_000_000, "tariff_reduction");
  for (const c of [small, big])
    await enqueueDirtyClaim(getPool(), c.claimId, "materiality", "ingest");
  await drainClaimMateriality();
  const r1 = await drainEventMateriality();
  assert.equal(r1.failed, 0);
  const a1 = (await eventAssessmentsOf(eventId))[0];
  const proj = (await eventProjectionOf(eventId))[0];
  assert.equal(proj.assessment_id, a1.id);

  /* semantic claim change on the tariff claim → new claim assessment →
   * event dirty → next event drain mints a second event assessment */
  const v2 = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, state,
        observed_at, previous_version_id, change_type, content_hash)
     VALUES ($1, $2, 2, 'number', '60000000000'::jsonb, 'usd',
             'corrected', now(), $3, 'corrected', $4)`,
    [v2, big.claimId, big.versionId, `ch-${v2}`],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [v2, big.claimId],
  );
  await enqueueDirtyClaim(getPool(), big.claimId, "materiality", "adjudicate");
  await drainClaimMateriality();
  assert.ok(
    (await pendingDirtyEvents(EVENT_DIRTY_JOB)).length > 0,
    "claim semantic change must cascade-dirty the parent event",
  );
  const r2 = await drainEventMateriality();
  assert.equal(r2.failed, 0);
  const all = await eventAssessmentsOf(eventId);
  assert.equal(all.length, 2, "new claim set mints a new event assessment");
});
