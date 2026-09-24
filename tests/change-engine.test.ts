/**
 * Change Engine V1 regression matrix — the spec's 8 required cases plus
 * retraction and event resolution. Each case exercises the decision table:
 * who asserts (primary / prior asserter / new outlet) decides the change
 * type, not just the value diff.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import {
  persistCluster,
  resolveStaleEvents,
  type ExtractedClaim,
} from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import { getEventView } from "../lib/db/read";
import type { Article, StoryCluster } from "../lib/model";

function setupDb() {
  const db = newDb();
  const path = fileURLToPath(
    new URL("../db/migrations/0001_core_schema.sql", import.meta.url),
  );
  const sql = readFileSync(path, "utf8")
    .replace(
      /CREATE OR REPLACE FUNCTION uuid_v7[\s\S]*?LANGUAGE plpgsql VOLATILE;/,
      "",
    )
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/, "");
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
    id: "c1",
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

const changeTypes = async (eventId: string) => {
  const { rows } = await getPool().query<{ type: string }>(
    `SELECT type FROM changes WHERE event_id = $1 ORDER BY detected_at`,
    [eventId],
  );
  return rows.map((r) => r.type);
};

const claimState = async () => {
  const { rows } = await getPool().query<{
    version_no: number;
    value: number;
    state: string;
  }>(
    `SELECT cv.version_no, cv.value, cv.state
     FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id`,
  );
  return rows;
};

test("matrix: 10 wire copies → one new_coverage, claim is NOT confirmed x10", async () => {
  setupDb();

  // round 1 — the wire originates the story
  const wire = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(wire, extractClaims(wire));

  // round 2 — 9 outlets republish the same fact
  const copies = cluster(
    ["VnExpress", "Tuổi Trẻ", "Thanh Niên", "Dân Trí", "VTV"].map((s) =>
      art({ source: s, title: "Bão lớn: 20 chuyến bay bị hủy" }),
    ),
  );
  const r2 = await persistCluster(copies, extractClaims(copies));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.deepEqual(
    types.filter((t) => t === "new_coverage"),
    ["new_coverage"],
    "one batched coverage change, not nine",
  );
  // corroboration volume must not mint versions or upgrade authority
  const cs = await claimState();
  assert.equal(cs.length, 1);
  assert.equal(cs[0].version_no, 1);
  assert.equal(cs[0].state, "reported");
});

test("matrix: Reuters=20, BBC=20 → coverage added → NO material change", async () => {
  setupDb();
  const a = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  const b = cluster([
    art({
      source: "BBC World News",
      title: "Storm grounds travel — 20 flights cancelled",
      language: "en",
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("new_coverage"));
  assert.ok(!types.includes("claim_updated"));
  assert.ok(!types.includes("claim_confirmed"));

  // no new event_version from coverage alone
  const { rows } = await getPool().query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM event_versions WHERE event_id = $1`,
    [r1.eventId],
  );
  assert.equal(Number(rows[0].c), 2); // event_created + new_claim only
});

test("matrix: primary confirms the same value → claim_confirmed", async () => {
  setupDb();
  const a = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  const official = cluster([
    art({ source: "Cục Hàng không", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r2 = await persistCluster(official, extractClaims(official), {
    sourceMeta: { "Cục Hàng không": { kind: "primary" } },
  });
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_confirmed"));
  assert.ok(types.includes("new_primary_source"));

  const cs = await claimState();
  assert.equal(cs[0].state, "confirmed");
  assert.equal(cs[0].value, 20);

  // the confirming doc originates the confirmed version with direct strength
  const { rows } = await getPool().query<{
    stance: string;
    evidence_strength: string;
  }>(
    `SELECT ce.stance, ce.evidence_strength
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     WHERE cv.state = 'confirmed'`,
  );
  assert.equal(rows[0].stance, "originates");
  assert.equal(rows[0].evidence_strength, "direct");
});

test("matrix: primary revises 20 → 35 → claim_updated + primary evidence", async () => {
  setupDb();
  const a = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  const official = cluster([
    art({ source: "Cục Hàng không", title: "Bão lớn: 35 chuyến bay bị hủy" }),
  ]);
  await persistCluster(official, extractClaims(official), {
    sourceMeta: { "Cục Hàng không": { kind: "primary" } },
  });

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_updated"));
  assert.ok(!types.includes("claim_disputed")); // authority revises ≠ conflict
  const cs = await claimState();
  assert.equal(cs[0].value, 35);
});

test("matrix: A=20, B=35 different outlets → claim_disputed", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  const b = cluster([
    art({ source: "Tuổi Trẻ", title: "Bão lớn: 35 chuyến bay bị hủy" }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_disputed"));

  const cs = await claimState();
  assert.equal(cs[0].state, "disputed");
  assert.equal(cs[0].value, 35);

  // the disputing document contradicts the new version
  const { rows } = await getPool().query<{ stance: string }>(
    `SELECT ce.stance FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     WHERE cv.state = 'disputed'`,
  );
  assert.equal(rows[0].stance, "contradicts");

  const view = await getEventView(r1.eventId);
  assert.equal(view!.confidence.contradictions, 1);
});

test("matrix: a source revises its own number → claim_corrected", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 35 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // the SAME source corrects its figure 35 → 30
  const b = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 30 chuyến bay bị hủy" }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_corrected"));

  const cs = await claimState();
  assert.equal(cs[0].state, "corrected");
  assert.equal(cs[0].value, 30);

  const { rows } = await getPool().query<{ stance: string }>(
    `SELECT ce.stance FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     WHERE cv.state = 'corrected'`,
  );
  assert.equal(rows[0].stance, "corrects");
});

test("matrix: headline changes, claim same → NO material change", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // new document, completely different headline, same fact —
  // claim-overlap merge path must keep the event, and nothing material emits
  const b = cluster([
    art({
      source: "Tuổi Trẻ",
      title: "Hàng không đình trệ vì siêu bão — 20 chuyến bay bị hủy",
    }),
  ]);
  const before = await changeTypes(r1.eventId);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId, "same claim_key → same event");

  // only coverage is added — no material change
  const after = await changeTypes(r1.eventId);
  const added = after.slice(before.length);
  assert.deepEqual(added, ["new_coverage"]);
});

test("matrix: explicit retraction → claim_retracted", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // a source retracts its earlier figure — extractor V1 never emits this
  // state; LLM/manual extractors can, so the engine must honor it.
  // claimKey must match the live claim ("Bão lớn" matches no SUBJECT_HINT
  // so the key is the bare predicate).
  const retract: ExtractedClaim = {
    claimKey: "flights_cancelled",
    predicate: "flights_cancelled",
    value: 20,
    valueType: "number",
    unit: "flights",
    state: "retracted",
    label: "Số chuyến bay bị hủy",
    assertedBy: "VnExpress",
  };
  const b = cluster([art({ source: "VnExpress", title: "Xin lỗi bạn đọc" })]);
  await persistCluster(b, [retract]);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_retracted"));
  const cs = await claimState();
  assert.equal(cs[0].state, "retracted");
});

test("matrix: stale event → event_resolved, terminal version", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // age the event past the resolve window
  await getPool().query(
    `UPDATE events SET last_seen_at = now() - interval '72 hours'
     WHERE id = $1`,
    [r1.eventId],
  );

  const n = await resolveStaleEvents();
  assert.equal(n, 1);

  const view = await getEventView(r1.eventId);
  assert.equal(view!.status, "resolved");
  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("event_resolved"));

  // a second sweep resolves nothing — resolved events don't re-fire
  assert.equal(await resolveStaleEvents(), 0);
});
