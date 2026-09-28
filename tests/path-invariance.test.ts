/**
 * R6.1b path-invariance — the same evidence graph must yield the same
 * canonical truth regardless of processing path: ingest order A→B or
 * B→A, live ingest or batch adjudication, early or late document
 * arrival. These are integration tests over the real writer + shared
 * position engine + batch adjudicator + relineage reconciler on pg-mem.
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
import {
  checkpointCursor,
  finishJob,
  lastDoneCursor,
  markDirtyDone,
  pendingDirtyEvents,
  startJob,
} from "../lib/db/jobs";
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

function art(over: Partial<Article>): Article {
  return {
    id: over.id ?? randomUUID(),
    title: over.title ?? "title",
    summary: over.summary ?? "",
    url: over.url ?? `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: over.publishedAt ?? new Date().toISOString(),
    source: over.source ?? "VnExpress",
    topic: over.topic ?? "world",
    headline: false,
    appearances: [],
    language: over.language ?? "vi",
  };
}

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

async function claimStates(eventId: string) {
  const { rows } = await getPool().query<{
    claim_id: string;
    state: string;
    value: unknown;
  }>(
    `SELECT c.id AS claim_id, cv.state, cv.value
       FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
      WHERE c.event_id = $1`,
    [eventId],
  );
  return rows;
}

async function countClaimVersions(claimId: string) {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM claim_versions WHERE claim_id = $1`,
    [claimId],
  );
  return rows[0].n;
}

async function auditTypes(eventId: string) {
  const { rows } = await getPool().query<{ type: string }>(
    `SELECT DISTINCT type FROM changes WHERE event_id = $1`,
    [eventId],
  );
  return rows.map((r) => r.type);
}

const BBC_TITLE = "Storm grounds travel — 20 flights cancelled, 15000 stranded";

function bbcArt(h: number) {
  return art({
    source: "BBC World News",
    title: BBC_TITLE,
    summary:
      "Airports confirmed 20 cancellations and roughly 15000 stranded " +
      "passengers after the storm made landfall.",
    language: "en",
    publishedAt: at(h),
  });
}
function reutersArt(h: number) {
  return art({
    source: "Reuters",
    title: "Bão lớn: 20 chuyến bay bị hủy, 15000 hành khách mắc kẹt",
    publishedAt: at(h),
  });
}

/* ── A. wire copies never corroborate ─────────────────────────────── */

test("invariance: 5 wire copies of Reuters → 1 origin → never supported", async () => {
  setupDb();
  const wire = cluster([reutersArt(0)]);
  const r1 = await persistCluster(wire, extractClaims(wire));
  const copies = cluster(
    ["VnExpress", "Tuổi Trẻ", "Thanh Niên", "Dân Trí", "VTV"].map((s) =>
      art({ source: s, title: reutersArt(0).title, publishedAt: at(1) }),
    ),
  );
  const r2 = await persistCluster(copies, extractClaims(copies));
  assert.equal(r2.eventId, r1.eventId);

  /* batch adjudication sees the SAME collapsed origins as ingest */
  const decisions = await adjudicateEvents([r1.eventId]);
  const cs = await claimStates(r1.eventId);
  for (const c of cs) assert.equal(c.state, "reported");
  assert.equal(
    decisions.filter((d) => d.to === "supported").length,
    0,
    "reprints must never mint 'supported'",
  );
});

/* ── B. two independent origins → supported (batch) ───────────────── */

test("invariance: Reuters + BBC independently agree → batch mints supported", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([bbcArt(1)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const decisions = await adjudicateEvents([r1.eventId]);
  const claim = (await claimStates(r1.eventId)).find(
    (c) => Number(c.value) === 20,
  )!;
  assert.equal(claim.state, "supported");
  const d = decisions.find((d) => d.to === "supported")!;
  assert.equal(d.reason, "independent_corroboration");
  assert.ok((await auditTypes(r1.eventId)).includes("claim_supported"));
});

/* ── C. batch CAN mint confirmed — path-invariant truth ──────────── */

test("invariance: primary evidence attached retroactively → batch mints confirmed", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const claim = (await claimStates(r1.eventId)).find(
    (c) => Number(c.value) === 20,
  )!;
  assert.equal(claim.state, "reported");

  /* a backfill/attachment re-rates the existing evidence as DIRECT
   * (strength lives on claim_evidence, not the doc) — e.g. provenance
   * review discovers the reporting doc WAS the authoritative filing */
  const { rows: ver } = await getPool().query<{ id: string }>(
    `SELECT cv.id FROM claims c
       JOIN claim_versions cv ON cv.id = c.current_version_id
      WHERE c.id = $1`,
    [claim.claim_id],
  );
  await getPool().query(
    `UPDATE claim_evidence SET evidence_strength = 'direct'
      WHERE claim_version_id = $1`,
    [ver[0].id],
  );

  const decisions = await adjudicateEvents([r1.eventId]);
  const after = (await claimStates(r1.eventId)).find(
    (c) => c.claim_id === claim.claim_id,
  )!;
  /* identical to what ingest would have minted had the primary evidence
   * been present live — state is a function of evidence, not path */
  assert.equal(after.state, "confirmed");
  const d = decisions.find((d) => d.claimId === claim.claim_id)!;
  assert.equal(d.to, "confirmed");
  assert.equal(d.reason, "primary_asserted");
});

/* ── D. provenance change recomputes mutable truth ────────────────── */

test("invariance: supported → lineage collapse → recomputed back to reported", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([bbcArt(2)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  await adjudicateEvents([r1.eventId]);
  const claim = (await claimStates(r1.eventId)).find(
    (c) => Number(c.value) === 20,
  )!;
  assert.equal(claim.state, "supported");

  /* late arrival: the Reuters wire piece BBC rewrote arrives at t=1
   * (before BBC's t=2) — provenance corrects BBC: original → syndicated */
  const late = cluster([
    art({
      source: "Reuters",
      title: BBC_TITLE,
      summary:
        "Airports confirmed 20 cancellations and roughly 15000 stranded " +
        "passengers after the storm made landfall.",
      language: "en",
      publishedAt: at(1),
    }),
  ]);
  const r3 = await persistCluster(late, extractClaims(late));
  assert.equal(r3.eventId, r1.eventId);

  const rel = await relineageEvents([r1.eventId]);
  assert.equal(rel.failedEventIds.length, 0);
  const { rows: bbcLin } = await getPool().query<{ relation: string }>(
    `SELECT el.relation::text FROM evidence_lineage el
       JOIN evidence_documents ed ON ed.id = el.child_document_id
       JOIN sources s ON s.id = ed.source_id
      WHERE s.name = 'BBC World News'
      ORDER BY el.version_no DESC LIMIT 1`,
  );
  assert.ok(
    ["syndicated", "rewritten", "quoted"].includes(bbcLin[0]?.relation),
    `BBC doc reclassified derived, got ${bbcLin[0]?.relation}`,
  );

  /* two "independent" origins are now ONE root — truth must follow
   * provenance down, not stay supported forever */
  await adjudicateEvents([r1.eventId]);
  const after = (await claimStates(r1.eventId)).find(
    (c) => c.claim_id === claim.claim_id,
  )!;
  assert.equal(after.state, "reported");
  const { rows: vt } = await getPool().query<{ ct: string }>(
    `SELECT cv.change_type::text AS ct FROM claim_versions cv
      WHERE cv.claim_id = $1 ORDER BY cv.version_no DESC LIMIT 1`,
    [claim.claim_id],
  );
  assert.equal(vt[0].ct, "recomputed");
});

/* ── E. disputed resolves when B corrects into A ──────────────────── */

test("invariance: disputed → B corrects into A's value → resolved", async () => {
  setupDb();
  const a = cluster([
    art({
      source: "VnExpress",
      title: "Bão lớn: 20 chuyến bay bị hủy",
      publishedAt: at(0),
    }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([
    art({
      source: "Tuổi Trẻ",
      title: "Bão lớn: 35 chuyến bay bị hủy",
      publishedAt: at(1),
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  await adjudicateEvents([r1.eventId]);
  const disputed = (await claimStates(r1.eventId)).find(
    (c) => c.state === "disputed",
  );
  assert.ok(disputed, "conflicting live positions → disputed");

  /* B retracts its figure and asserts A's value — 'đính chính' wording
   * keeps it an independent assertion, not a syndication of A */
  const b2 = cluster([
    art({
      source: "Tuổi Trẻ",
      title: "Đính chính: con số đúng là 20 chuyến bay bị hủy",
      publishedAt: at(3),
    }),
  ]);
  const r3 = await persistCluster(b2, extractClaims(b2));
  assert.equal(r3.eventId, r1.eventId);

  await adjudicateEvents([r1.eventId]);
  const after = (await claimStates(r1.eventId)).find(
    (c) => c.claim_id === disputed!.claim_id,
  )!;
  /* B's live vote moved to 20 — the dispute must RESOLVE. 'corrected'
   * if the writer recorded B's self-revision at ingest (authority act);
   * 'supported' once the batch sees both origins on one position.
   * Either way the claim can no longer stand 'disputed'. */
  assert.ok(
    ["corrected", "supported"].includes(after.state),
    `dispute resolved, got ${after.state}`,
  );
});

/* ── F. ingest ORDER does not change the answer ───────────────────── */

test("invariance: same evidence, A→B vs B→A ingest → same state", async () => {
  const run = async (order: "ab" | "ba") => {
    setupDb();
    const clusters =
      order === "ab"
        ? [cluster([reutersArt(0)]), cluster([bbcArt(1)])]
        : [cluster([bbcArt(0)]), cluster([reutersArt(1)])];
    let eventId = "";
    for (const c of clusters) {
      const r = await persistCluster(c, extractClaims(c));
      eventId = r.eventId;
    }
    await adjudicateEvents([eventId]);
    const cs = await claimStates(eventId);
    const { rows: roots } = await getPool().query<{ rel: string }>(
      `SELECT DISTINCT ON (el.child_document_id) el.relation::text AS rel
         FROM evidence_lineage el
         JOIN evidence_documents ed ON ed.id = el.child_document_id
         JOIN event_evidence ee ON ee.evidence_version_id = ed.current_version_id
        WHERE ee.event_id = $1
        ORDER BY el.child_document_id, el.version_no DESC`,
      [eventId],
    );
    return { cs, roots: roots.map((r) => r.rel).sort() };
  };
  const ab = await run("ab");
  const ba = await run("ba");
  assert.deepEqual(
    ab.cs.map((c) => c.state).sort(),
    ba.cs.map((c) => c.state).sort(),
    "claim truth independent of ingest order",
  );
  assert.deepEqual(
    ab.roots,
    ba.roots,
    "lineage roots independent of ingest order",
  );
});

/* ── G. cursor correctness ────────────────────────────────────────── */

test("cursor: failed event freezes the watermark — retried next run", async () => {
  setupDb();
  const evs = [
    { id: "e1", lastSeenAt: "2026-05-10T01:00:00Z" },
    { id: "e2", lastSeenAt: "2026-05-10T02:00:00Z" },
    { id: "e3", lastSeenAt: "2026-05-10T03:00:00Z" },
  ];
  /* e2 failed: cursor stays at e1 — e3 committed but stays BEHIND the
   * watermark so the next sweep re-examines it too (idempotent) */
  const cur = checkpointCursor(evs, new Set(["e2"]), "2026-05-10T00:00:00Z");
  assert.equal(cur, "2026-05-10T01:00:00Z");

  /* a run with failures lands 'partial', not 'done' — and its cursor
   * remains a valid resumption watermark */
  const run = await startJob("enrich");
  await finishJob(run.id, { processed: 1, failed: 1, cursorTs: cur });
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT status FROM job_runs WHERE id = $1`,
    [run.id],
  );
  assert.equal(rows[0].status, "partial");
  /* timestamptz comes back as Date — same instant, either shape */
  assert.equal(
    new Date((await lastDoneCursor("enrich"))!).toISOString(),
    new Date(cur).toISOString(),
  );
});

test("cursor: stale 'running' job recovered when the next run starts", async () => {
  setupDb();
  const dead = await startJob("adjudicate");
  await getPool().query(
    `UPDATE job_runs SET started_at = now() - interval '2 hours'
      WHERE id = $1`,
    [dead.id],
  );
  await startJob("adjudicate"); // next run proves the old one died
  const { rows } = await getPool().query<{
    status: string;
    error: string | null;
  }>(`SELECT status, error FROM job_runs WHERE id = $1`, [dead.id]);
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].error ?? "", /stale/);
});

/* ── H. the orchestration gap: relineage on an OLD event ────────────
 * events.last_seen_at does not move when batch lineage rewrites
 * provenance, so a time-cursor adjudicate sweep would skip it forever.
 * The dirty_events queue is the hand-off: relineage enqueues inside its
 * mint transaction; adjudication drains regardless of timestamps. */
test("orchestration: relineage dirties an event the time-cursor already passed", async () => {
  setupDb();
  const a = cluster([reutersArt(0)]);
  const r1 = await persistCluster(a, extractClaims(a));
  const b = cluster([bbcArt(2)]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
  await adjudicateEvents([r1.eventId]);
  const claim = (await claimStates(r1.eventId)).find(
    (c) => Number(c.value) === 20,
  )!;
  assert.equal(claim.state, "supported");
  const versionsBefore = await countClaimVersions(claim.claim_id);

  /* The wire parent lived on ANOTHER event all along — cross-event doc
   * sharing the ingest path never saw. Raw SQL because the resolver
   * would merge this doc into X (same claim fingerprint). */
  const { rows: evRows } = await getPool().query<{
    event_id: string;
    bbc_doc: string;
    bbc_version: string;
  }>(
    `SELECT $1::uuid AS event_id, d.id AS bbc_doc, ee.evidence_version_id AS bbc_version
       FROM event_evidence ee
       JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
       JOIN evidence_documents d ON d.id = ev.document_id
       JOIN sources s ON s.id = d.source_id
      WHERE ee.event_id = $1 AND s.name = 'BBC World News'`,
    [r1.eventId],
  );
  const bbc = evRows[0];
  const { rows: yRows } = await getPool().query<{ id: string }>(
    `INSERT INTO events (event_type, topic, status, first_seen_at, last_seen_at)
     VALUES ('other', 'world', 'emerging', '2020-01-01', '2020-01-01')
     RETURNING id`,
  );
  const eventY = yRows[0].id;
  const { rows: srcRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM sources WHERE name = 'Reuters'`,
  );
  const { rows: dRows } = await getPool().query<{ id: string }>(
    `INSERT INTO evidence_documents
       (source_id, canonical_url, published_at, first_seen_at,
        last_seen_at, discovered_via)
     VALUES ($1, 'https://reuters.example/wire-parent',
             $2::timestamptz, now(), now(), 'rss')
     RETURNING id`,
    [srcRows[0].id, at(1)],
  );
  const { rows: vRows } = await getPool().query<{ id: string }>(
    `INSERT INTO evidence_versions
       (document_id, version_no, title, summary, content_hash, observed_at)
     VALUES ($1, 1, $2, $3, 'h-wire-parent', now())
     RETURNING id`,
    [dRows[0].id, BBC_TITLE, "Wire copy of the storm travel disruption."],
  );
  const p = { doc: dRows[0].id, ver: vRows[0].id };
  await getPool().query(
    `UPDATE evidence_documents SET current_version_id = $1 WHERE id = $2`,
    [p.ver, p.doc],
  );
  await getPool().query(
    `INSERT INTO event_evidence
       (event_id, evidence_version_id, attached_by)
     VALUES ($1, $2, 'manual'), ($1, $3, 'manual')`,
    [eventY, p.ver, bbc.bbc_version],
  );

  /* batch relineage on X alone must still see P (union pool across the
   * doc's full attachment set) and dirty BOTH events it touches */
  const rl = await relineageEvents([r1.eventId]);
  assert.deepEqual(
    [...rl.changedEventIds].sort(),
    [r1.eventId, eventY].sort(),
    "every event sharing a re-minted doc must be handed to adjudication",
  );

  /* simulate the gap exactly: the event looks OLD to the time cursor
   * (as if the correction landed without ingest touching last_seen_at) */
  await getPool().query(
    `UPDATE events SET last_seen_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
    [r1.eventId],
  );

  /* the queue — not the timestamp — carries the work */
  const pending = await pendingDirtyEvents("adjudicate");
  assert.ok(
    pending.includes(r1.eventId) && pending.includes(eventY),
    "relineage must dirty every event whose docs were re-minted",
  );

  await adjudicateEvents(pending);
  /* per-item ack: finishing X leaves Y retryable — acknowledgement is
   * never implicit in the batch */
  await markDirtyDone(r1.eventId, "adjudicate");
  assert.deepEqual(await pendingDirtyEvents("adjudicate"), [eventY]);
  await markDirtyDone(eventY, "adjudicate");
  const after = (await claimStates(r1.eventId)).find(
    (c) => c.claim_id === claim.claim_id,
  )!;
  assert.equal(
    after.state,
    "reported",
    "provenance shrink must reach claim truth even when the event " +
      "is behind the adjudicate cursor",
  );
  assert.equal((await pendingDirtyEvents("adjudicate")).length, 0);

  /* idempotent: draining again mints no further versions */
  await adjudicateEvents([r1.eventId, eventY]);
  assert.equal(await countClaimVersions(claim.claim_id), versionsBefore + 1);
});
