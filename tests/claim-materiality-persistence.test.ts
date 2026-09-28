/**
 * R7.1c persistence — generation-safe claim-materiality pipeline on
 * pg-mem. The load-bearing invariants are races, not outputs:
 *
 *   - publish+ack are ONE transaction bound to (claim_version_id,
 *     dirty generation) — a stale worker publishes NOTHING and acks
 *     NOTHING, leaving the newer unit pending
 *   - assessments are append-only and idempotent: same semantic input
 *     reuses the row; a provenance-only change mints a new one
 *   - producers hand off atomically: writer / adjudicator / relineage
 *     enqueue inside the same transaction as the dirtying write
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import { persistCluster } from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import { adjudicateEvents } from "../lib/db/adjudicate";
import { relineageEvents } from "../lib/db/relineage";
import { enqueueDirtyClaim, pendingDirtyClaims } from "../lib/db/jobs";
import {
  claimInputHash,
  drainClaimMateriality,
  loadClaimMaterialityInputs,
  publishClaimAssessment,
} from "../lib/db/claim-materiality";
import {
  scoreClaimMateriality,
  type ClaimMaterialityInput,
} from "../lib/materiality-claims";
import type { Article, StoryCluster } from "../lib/model";

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

const T0 = Date.parse("2026-05-10T08:00:00Z");
const at = (h: number) => new Date(T0 + h * 3600_000).toISOString();

/* ── direct-SQL fixtures — surgical control over truth history ── */

async function mkEvent() {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO events (id, topic, status, first_seen_at, last_seen_at)
     VALUES ($1, 'world', 'emerging', now(), now())`,
    [id],
  );
  return id;
}

async function mkSource(name: string, kind = "publisher") {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO sources (id, name, kind) VALUES ($1, $2, $3::source_kind)`,
    [id, name, kind],
  );
  return id;
}

async function mkDoc(
  sourceId: string,
  publishedAt: string,
  relation: "original" | "syndicated" = "original",
  parentDocId: string | null = null,
) {
  const docId = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_documents
       (id, source_id, canonical_url, first_seen_at, last_seen_at,
        discovered_via)
     VALUES ($1, $2, $3, $4, $4, 'rss')`,
    [docId, sourceId, `https://x.vn/${docId}`, publishedAt],
  );
  const evId = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_versions
       (id, document_id, version_no, title, content_hash, observed_at)
     VALUES ($1, $2, 1, 't', $3, $4)`,
    [evId, docId, `h-${docId}`, publishedAt],
  );
  /* lineage row — 'original' marks the doc its own root (a confirmed
   * independent origin in R6 semantics); derived relations re-root */
  await getPool().query(
    `INSERT INTO evidence_lineage
       (child_document_id, version_no, parent_document_id,
        origin_document_id, relation, confidence, method)
     VALUES ($1, 1, $2, $3, $4::lineage_relation, 1, 'rule')`,
    [
      docId,
      parentDocId,
      relation === "original" ? null : parentDocId,
      relation,
    ],
  );
  return { docId, evId };
}

async function mkClaim(opts: {
  eventId: string;
  predicate?: string;
  value: unknown;
  unit?: string | null;
  state?: string;
  qualifiers?: Record<string, unknown>;
}) {
  const claimId = randomUUID();
  await getPool().query(
    `INSERT INTO claims
       (id, event_id, claim_key, predicate, claim_type,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 'fact', now(), now())`,
    [claimId, opts.eventId, `k-${claimId}`, opts.predicate ?? "money_usd"],
  );
  const versionId = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, qualifiers,
        state, observed_at, change_type, content_hash)
     VALUES ($1, $2, 1, 'number', $3::jsonb, $4, $5::jsonb,
             $6::claim_state, now(), 'initial', $7)`,
    [
      versionId,
      claimId,
      JSON.stringify(opts.value),
      opts.unit ?? "usd",
      opts.qualifiers ? JSON.stringify(opts.qualifiers) : null,
      opts.state ?? "reported",
      `ch-${versionId}`,
    ],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [versionId, claimId],
  );
  return { claimId, versionId };
}

async function linkEvidence(
  claimVersionId: string,
  evId: string,
  strength = "secondary",
) {
  await getPool().query(
    `INSERT INTO claim_evidence
       (claim_version_id, evidence_version_id, stance,
        evidence_strength, extraction_method)
     VALUES ($1, $2, 'supports', $3::evidence_strength, 'rule')`,
    [claimVersionId, evId, strength],
  );
}

const q = async <T>(sql: string, params: unknown[]) =>
  (await getPool().query(sql, params)).rows as T[];

const assessmentsOf = (claimId: string) =>
  q<{
    id: string;
    claim_version_id: string;
    input_hash: string;
    intrinsic_materiality: string;
    excluded: boolean;
  }>(
    `SELECT id, claim_version_id, input_hash, intrinsic_materiality,
            excluded
       FROM claim_materiality_assessments WHERE claim_id = $1
      ORDER BY assessed_at`,
    [claimId],
  );

const projectionOf = (claimId: string) =>
  q<{
    assessment_id: string;
    claim_version_id: string;
    source_generation: number;
  }>(
    `SELECT assessment_id, claim_version_id, source_generation::int
       FROM claim_materiality_current WHERE claim_id = $1`,
    [claimId],
  );

const dirtyOf = (claimId: string) =>
  q<{
    generation: number;
    processed_at: Date | null;
    reason: string;
  }>(
    `SELECT generation::int AS generation, processed_at, reason
       FROM dirty_claims
      WHERE claim_id = $1 AND job = 'materiality'`,
    [claimId],
  );

async function inputOf(claimId: string) {
  const m = await loadClaimMaterialityInputs([claimId]);
  const r = m.get(claimId);
  assert.ok(r, `canonical input for ${claimId}`);
  return r.input;
}

/* ── idempotency + provenance-driven rescoring ──────────────── */

test("same input twice → one assessment, one projection; replay reuses", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId } = await mkClaim({
    eventId,
    value: 500,
    unit: "usd",
  });
  const src = await mkSource("Reuters");
  const { evId } = await mkDoc(src, at(0));
  await linkEvidence(versionId, evId);

  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  const r1 = await drainClaimMateriality();
  assert.equal(r1.processed, 1);
  assert.equal(r1.assessmentsInserted, 1);
  assert.equal(r1.failed, 0);
  assert.equal((await assessmentsOf(claimId)).length, 1);
  assert.equal((await projectionOf(claimId)).length, 1);
  assert.equal((await pendingDirtyClaims("materiality")).length, 0);

  // re-enqueue identical state: new generation, same semantic input
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "manual");
  const r2 = await drainClaimMateriality();
  assert.equal(r2.assessmentsReused, 1);
  assert.equal(r2.assessmentsInserted, 0);
  assert.equal((await assessmentsOf(claimId)).length, 1, "no duplicate");
  assert.equal((await projectionOf(claimId))[0].source_generation, 2);
});

test("provenance change on the same claim_version → new hash + new assessment", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId } = await mkClaim({
    eventId,
    value: 500,
    unit: "usd",
  });
  const src = await mkSource("Reuters");
  const { evId } = await mkDoc(src, at(0));
  await linkEvidence(versionId, evId);

  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  await drainClaimMateriality();
  const before = await assessmentsOf(claimId);
  assert.equal(before.length, 1);

  // a second INDEPENDENT origin joins — provenance stats change while
  // claim_version_id is untouched → the semantic hash must differ
  const src2 = await mkSource("BBC");
  const { evId: ev2 } = await mkDoc(src2, at(1));
  await linkEvidence(versionId, ev2);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");

  const input2 = await inputOf(claimId);
  assert.notEqual(claimInputHash(input2), before[0].input_hash);
  assert.equal(input2.evidence.confirmedIndependentOrigins, 2);

  const r2 = await drainClaimMateriality();
  assert.equal(r2.assessmentsInserted, 1);
  const after = await assessmentsOf(claimId);
  assert.equal(after.length, 2, "provenance delta mints a new assessment");
  assert.equal(after[1].claim_version_id, before[0].claim_version_id);
});

/* ── generation race matrix ─────────────────────────────────── */

test("gen1 worker vs re-enqueued gen2 → gen1 cannot publish or ack", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim({ eventId, value: 500, unit: "usd" });
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");

  // worker A reads gen=1
  const input = await inputOf(claimId);
  // producer re-enqueues mid-flight → gen=2 pending
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "relineage");

  const res = await publishClaimAssessment(
    { claimId, generation: 1 },
    input,
    scoreClaimMateriality(input),
  );
  assert.equal(res.status, "stale");
  assert.equal((await assessmentsOf(claimId)).length, 0);
  assert.equal((await projectionOf(claimId)).length, 0);
  const d = (await dirtyOf(claimId))[0];
  assert.equal(d.generation, 2);
  assert.equal(d.processed_at, null, "gen2 stays pending — not acked");
});

test("worker read v1 → writer lands v2 + gen2 → v1 cannot publish", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId: v1 } = await mkClaim({
    eventId,
    value: 500,
    unit: "usd",
  });
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");

  const staleInput = await inputOf(claimId); // scored against v1
  // a concurrent truth write lands a new version and dirties the claim
  const v2 = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, state,
        observed_at, previous_version_id, change_type, content_hash)
     VALUES ($1, $2, 2, 'number', '600'::jsonb, 'usd', 'corrected',
             now(), $3, 'corrected', $4)`,
    [v2, claimId, v1, `ch-${v2}`],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [v2, claimId],
  );
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "adjudicate");

  const res = await publishClaimAssessment(
    { claimId, generation: 1 },
    staleInput,
    scoreClaimMateriality(staleInput),
  );
  assert.equal(res.status, "stale", "stale version must not publish");
  assert.equal((await projectionOf(claimId)).length, 0);
});

test("drain re-reads after a stale-only pass — same run drains the newer generation", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim({ eventId, value: 500, unit: "usd" });
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");

  /* deterministic mid-flight producer: patch the pool so that the first
   * pending-read resolves, THEN the generation bumps — the pass's publish
   * attempt goes stale, and the fixed loop must re-read and drain gen2
   * inside the SAME run instead of breaking on progress===0. */
  const pool = getPool();
  type QFn = (sql: string, params?: unknown[]) => Promise<unknown>;
  const origQuery = pool.query.bind(pool) as unknown as QFn;
  let bumped = false;
  const patched: QFn = async (sql, params) => {
    const res = await origQuery(sql, params);
    /* after the pending read resolves, bump generation — the subsequent
     * publish in this pass must go stale; the drain loop then has to
     * re-read and drain gen2 in the SAME run */
    if (!bumped && sql.includes("FROM dirty_claims")) {
      bumped = true;
      await origQuery(
        `UPDATE dirty_claims
           SET generation = generation + 1, processed_at = NULL
         WHERE claim_id = $1 AND job = 'materiality'`,
        [claimId],
      );
    }
    return res;
  };
  (pool as { query: unknown }).query = patched;
  try {
    const r = await drainClaimMateriality();
    assert.equal(r.staleGeneration, 1, "pass 1's publish went stale");
    assert.equal(r.processed, 1, "pass 2 drained gen2 in the same run");
    assert.equal(r.pendingRemaining, 0);
    assert.equal(r.failed, 0);
    const p = (await projectionOf(claimId))[0];
    assert.equal(p.source_generation, 2, "projection carries gen2");
    assert.equal((await assessmentsOf(claimId)).length, 1);
  } finally {
    (pool as { query: unknown }).query = origQuery;
  }
});

test("gen2 publishes → stale gen1 finishes later → projection stays gen2", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim({ eventId, value: 500, unit: "usd" });
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");

  const input = await inputOf(claimId);
  const assessment = scoreClaimMateriality(input);
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "relineage");

  // worker B wins on gen2 (same content → assessment reused path is
  // still a legit publish for its generation)
  const b = await publishClaimAssessment(
    { claimId, generation: 2 },
    input,
    assessment,
  );
  assert.equal(b.status, "published");
  // worker A's gen1 finishes AFTER — must not downgrade the projection
  const a = await publishClaimAssessment(
    { claimId, generation: 1 },
    input,
    assessment,
  );
  assert.equal(a.status, "stale");
  const p = (await projectionOf(claimId))[0];
  assert.equal(p.source_generation, 2);
});

/* ── producer hand-offs are atomic with the dirtying write ──── */

function cluster(articles: Article[]): StoryCluster {
  return {
    id: `c-${randomUUID()}`,
    title: articles[0].title,
    summary: articles[0].summary,
    leadArticle: articles[0],
    articles,
    sources: articles.map((a) => ({ name: a.source, url: a.url })),
    topic: "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: articles[0].publishedAt,
  };
}
const STORM = "Storm grounds travel — 20 flights cancelled, 15000 stranded";
const artOf = (
  source: string,
  h: number,
  title = STORM,
  language: "en" | "vi" = "en",
): Article => ({
  id: randomUUID(),
  title,
  summary:
    "Airports confirmed 20 cancellations and roughly 15000 stranded " +
    "passengers after the storm made landfall.",
  url: `https://x.vn/${randomUUID()}`,
  image: null,
  publishedAt: at(h),
  source,
  topic: "world",
  headline: false,
  appearances: [],
  language,
});
/* vi/en paraphrase pair — same story, different wording: neither is a
 * reprint of the other, so adjudication counts two real origins */
const reutersArt = (h: number) =>
  artOf(
    "Reuters",
    h,
    "Bão lớn: 20 chuyến bay bị hủy, 15000 hành khách mắc kẹt",
    "vi",
  );
const bbcArt = (h: number) => artOf("BBC World News", h, STORM, "en");

async function claimsOfEvent(eventId: string) {
  return q<{ claim_id: string; state: string; value: unknown }>(
    `SELECT c.id AS claim_id, cv.state::text, cv.value
       FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
      WHERE c.event_id = $1`,
    [eventId],
  );
}

test("writer: claim_evidence attached without value change → claim dirty", async () => {
  setupDb();
  const a = cluster([artOf("Reuters", 0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const before = await pendingDirtyClaims("materiality");
  assert.ok(before.length > 0, "new claims dirty on birth");

  // drain clean, then a corroborating copy attaches evidence WITHOUT
  // minting a version — the claim still gets re-dirtied
  await drainClaimMateriality();
  assert.equal((await pendingDirtyClaims("materiality")).length, 0);

  const b = cluster([artOf("VnExpress", 1)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  const pending = await pendingDirtyClaims("materiality");
  assert.ok(pending.length > 0, "evidence-only attach must dirty");
});

test("adjudicator reported→supported mints version AND dirty row atomically", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([bbcArt(1)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  await drainClaimMateriality(); // settle ingest-time dirty rows

  const claim = (await claimsOfEvent(r1.eventId)).find(
    (c) => Number(c.value) === 20,
  )!;
  const { landed } = await adjudicateEvents([r1.eventId]);
  assert.ok(
    landed.some((d) => d.claimId === claim.claim_id && d.to === "supported"),
  );
  const d = (await dirtyOf(claim.claim_id))[0];
  assert.ok(d, "adjudicate mint must dirty the claim atomically");
  assert.equal(d.processed_at, null);
  assert.equal(d.reason, "adjudicate");
});

test("relineage dirties exactly the claims whose provenance changed", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([bbcArt(2)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  await adjudicateEvents([r1.eventId]);
  await drainClaimMateriality();
  assert.equal((await pendingDirtyClaims("materiality")).length, 0);

  // late wire original arrives → BBC collapses to syndicated. The
  // provenance correction may fire at ingest (writer's own lineage
  // pass) or in the batch reconciler — either way the claims backed
  // by the re-rooted doc must be dirty afterwards.
  const late = cluster([artOf("Reuters", 1)]);
  const r3 = await persistCluster(late, extractClaims(late));
  assert.equal(r3.eventId, r1.eventId);

  const rel = await relineageEvents([r1.eventId]);
  assert.equal(rel.failedEventIds.length, 0);
  const pending = await pendingDirtyClaims("materiality");
  assert.ok(
    pending.length > 0,
    "a provenance change must dirty claims backed by re-rooted docs",
  );
  const claimIds = new Set(pending.map((p) => p.claimId));
  const backed = await claimsOfEvent(r1.eventId);
  assert.ok(
    backed.some((c) => claimIds.has(c.claim_id)),
    "the dirtied set must include the claims on this event",
  );
});

/* ── contract pins ──────────────────────────────────────────── */

test("production input never fabricates economicComparison from truth history", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId: v1 } = await mkClaim({
    eventId,
    predicate: "interest_rate",
    value: 7,
    unit: "percent",
  });
  // truth convergence: same value re-stated with a new truth state —
  // the classic prod pattern, NOT an economic move
  const v2 = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit, state,
        observed_at, previous_version_id, change_type, content_hash)
     VALUES ($1, $2, 2, 'number', '7'::jsonb, 'percent', 'supported',
             now(), $3, 'supported', $4)`,
    [v2, claimId, v1, `ch-${v2}`],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [v2, claimId],
  );

  const input = await inputOf(claimId);
  assert.equal(input.previousVersion?.versionId, v1);
  assert.equal(input.economicComparison, null);
  // and the scorer must NOT invent a rate hike from truth history
  const a = scoreClaimMateriality(input);
  assert.notEqual(a.action, "monetary_policy_change");
});

test("retracted claim → persisted assessment exists with none + excluded", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId } = await mkClaim({
    eventId,
    predicate: "tariff_rate",
    value: 46,
    unit: "percent",
    state: "retracted",
  });
  await enqueueDirtyClaim(getPool(), claimId, "materiality", "ingest");
  const r = await drainClaimMateriality();
  assert.equal(r.failed, 0);
  const rows = await assessmentsOf(claimId);
  assert.equal(rows.length, 1, "retraction is itself scored + persisted");
  assert.equal(rows[0].intrinsic_materiality, "none");
  assert.equal(rows[0].excluded, true);
});

/* ── hash contract / corpus↔worker parity ───────────────────── */

function corpusShapedInput(base: ClaimMaterialityInput) {
  // the corpus JSON is loadClaimMaterialityInputs' output serialized —
  // rebuilding through JSON proves dump-path ≡ worker-path hashing
  return JSON.parse(JSON.stringify(base)) as ClaimMaterialityInput;
}

test("input hash: semantic content only — ids never counted, provenance always", async () => {
  setupDb();
  const eventId = await mkEvent();
  const { claimId, versionId } = await mkClaim({
    eventId,
    predicate: "tariff_rate",
    value: 20,
    unit: "percent",
  });
  const input = await inputOf(claimId);
  const h1 = claimInputHash(input);

  // corpus path (JSON round-trip) and worker path hash identically
  assert.equal(claimInputHash(corpusShapedInput(input)), h1);

  // record identity is NOT semantic input — same content, new version
  // id mints the same hash (dedup key carries the id separately)
  const newVer = {
    ...input,
    current: { ...input.current, versionId: randomUUID() },
  };
  assert.equal(claimInputHash(newVer), h1);

  // provenance IS semantic — one more origin must change the hash
  const richer = {
    ...input,
    evidence: { ...input.evidence, confirmedIndependentOrigins: 9 },
  };
  assert.notEqual(claimInputHash(richer), h1);

  // and a claim-state flip changes the hash too
  const flipped = {
    ...input,
    current: { ...input.current, state: "disputed" as const },
  };
  assert.notEqual(claimInputHash(flipped), h1);

  void versionId;
});
