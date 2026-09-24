/**
 * Change Engine V1 regression matrix — the spec's 8 required cases plus
 * retraction and event resolution. Each case exercises the decision table:
 * who asserts (primary / prior asserter / new outlet) decides the change
 * type, not just the value diff.
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
  persistCluster,
  resolveStaleEvents,
  type ExtractedClaim,
} from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import { getEventView } from "../lib/db/read";
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

  // no new event_version from coverage alone — and the creation cycle
  // batches event_created + new_claim into one snapshot
  const { rows } = await getPool().query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM event_versions WHERE event_id = $1`,
    [r1.eventId],
  );
  assert.equal(Number(rows[0].c), 1);
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
  assert.equal(cs[0].state, "confirmed"); // primary-backed position wins
});

test("matrix: A=20, B=35 different outlets → positions, not a flip", async () => {
  setupDb();
  const a = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // a different-value report from another domestic outlet — signature
  // carries the merge, the value becomes a disputed position inside
  const b = cluster([
    art({ source: "Tuổi Trẻ", title: "Bão lớn: 35 chuyến bay bị hủy" }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(types.includes("claim_disputed"));

  // the standing truth does NOT flip to 35 — one vs one, incumbent wins
  const cs = await claimState();
  assert.equal(cs[0].state, "disputed");
  assert.equal(cs[0].value, 20);

  // AP corroborates 20 — the position gains a supporter, no new version
  const c = cluster([
    art({
      source: "AP",
      title: "Storm grounds travel — 20 flights cancelled",
      language: "en",
    }),
  ]);
  await persistCluster(c, extractClaims(c));
  const after = await claimState();
  assert.equal(after[0].value, 20);
  assert.equal(after[0].state, "disputed");

  // EventView exposes both live positions
  const view = await getEventView(r1.eventId);
  const claim = view!.claims[0];
  assert.deepEqual(
    claim.positions?.map((p) => [p.value, p.sources]),
    [
      [20, ["VnExpress", "AP"]],
      [35, ["Tuổi Trẻ"]],
    ],
  );

  // the disputing document contradicts the position it introduced
  const { rows } = await getPool().query<{ stance: string }>(
    `SELECT ce.stance FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     WHERE cv.value = '35'::jsonb`,
  );
  assert.equal(rows[0].stance, "contradicts");
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

test("matrix: stale assertion arrives late → no correction, position stays", async () => {
  setupDb();
  // the NEWER figure lands first (feed delay is normal)
  const a = cluster([
    art({
      source: "VnExpress",
      title: "Bão lớn: 30 chuyến bay bị hủy",
      publishedAt: "2026-01-01T11:00:00Z",
    }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // then the source's OLDER article arrives — it asserts 20, but that's
  // history, not a revision: no claim_corrected, no vote movement
  const b = cluster([
    art({
      source: "VnExpress",
      title: "Bão lớn: 20 chuyến bay bị hủy",
      publishedAt: "2026-01-01T09:00:00Z",
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const types = await changeTypes(r1.eventId);
  assert.ok(!types.includes("claim_corrected"));
  assert.ok(!types.includes("claim_updated"));

  const cs = await claimState();
  assert.equal(cs[0].value, 30);
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

/* ------------------------- resolver hardening --------------------------- */

test("resolver: generic claim on different entities NEVER merges", async () => {
  setupDb();
  // the spec's failure case: a shared bare `deaths` key must not join a
  // Japan typhoon and an Indonesia earthquake
  const japan = cluster([
    art({
      source: "VnExpress",
      title: "Bão tại Nhật Bản: 15 người chết",
    }),
  ]);
  const r1 = await persistCluster(japan, extractClaims(japan));

  const indo = cluster([
    art({
      source: "Reuters",
      title: "Động đất Indonesia: 20 người chết",
    }),
  ]);
  const r2 = await persistCluster(indo, extractClaims(indo));

  assert.notEqual(
    r2.eventId,
    r1.eventId,
    "different places = different events",
  );

  const { rows } = await getPool().query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM events`,
  );
  assert.equal(Number(rows[0].c), 2);
});

test("resolver: same place + same generic value merges across languages", async () => {
  setupDb();
  const a = cluster([
    art({
      source: "VnExpress",
      title: "Bão Philippines: 20 chuyến bay bị hủy",
    }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  const b = cluster([
    art({
      source: "Reuters",
      title: "Philippines storm — 20 flights cancelled",
      language: "en",
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(
    r2.eventId,
    r1.eventId,
    "exact claim value + same entity merges",
  );
});

test("resolver: same place, different generic value — dispute not split", async () => {
  setupDb();
  const a = cluster([
    art({
      source: "VnExpress",
      title: "Bão Philippines: 20 chuyến bay bị hủy",
    }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // same entity (philippines) + high signature overlap carries the merge;
  // the differing value becomes a dispute inside the event, not a sibling
  const b = cluster([
    art({
      source: "Tuổi Trẻ",
      title: "Bão Philippines: 35 chuyến bay bị hủy",
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);

  const cs = await claimState();
  assert.equal(cs[0].state, "disputed");
});

test("resolver: subject-qualified claims merge regardless of value", async () => {
  setupDb();
  const a = cluster([
    art({
      source: "VnExpress",
      title: "Fed giữ lãi suất 4.25%",
    }),
  ]);
  const r1 = await persistCluster(a, extractClaims(a));

  // the Fed asserting a different rate later — same subject+predicate
  // identity (fed|interest_rate), value difference is an intra-event dispute
  const b = cluster([
    art({
      source: "Reuters",
      title: "Federal Reserve holds rate at 4.5%",
      language: "en",
    }),
  ]);
  const r2 = await persistCluster(b, extractClaims(b));
  assert.equal(r2.eventId, r1.eventId);
});

test("semantic: LLM claims enter canonical Claim path with method=model", async () => {
  const c = cluster([
    art({
      id: "vnx1",
      source: "VnExpress",
      title: "TP.HCM bổ sung 5 tuyến xe buýt điện",
    }),
    art({
      id: "tt1",
      source: "Tuổi Trẻ",
      title: "TP.HCM bổ sung tuyến xe buýt điện mới",
    }),
  ]);
  const r = await persistCluster(c, [
    {
      claimKey: "tp_hcm|bus_routes_added",
      predicate: "bus_routes_added",
      claimType: "fact",
      valueType: "number",
      value: 5,
      qualifiers: { subject: "TP.HCM" },
      label: "5 tuyến xe buýt điện",
      assertedBy: "VnExpress",
      articleId: "vnx1",
      method: "model",
    },
  ]);
  const pool = getPool() as Pool;
  const { rows } = await pool.query(
    `SELECT cv.value, ce.extraction_method, ce.stance
       FROM claims cl
       JOIN claim_versions cv ON cv.claim_id = cl.id
       JOIN claim_evidence ce ON ce.claim_version_id = cv.id
      WHERE cl.event_id = $1`,
    [r.eventId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extraction_method, "model");
  assert.equal(JSON.parse(String(rows[0].value)), 5);
});

test("semantic: validateExtractedClaims drops hallucinated sources/numbers", async () => {
  const { validateExtractedClaims } = await import("../lib/claims");
  const c = cluster([
    art({
      id: "vnx1",
      source: "VnExpress",
      title: "Giá vàng tăng lên 90 triệu đồng một lượng",
    }),
    art({
      id: "tt1",
      source: "Tuổi Trẻ",
      title: "Giá vàng 90 triệu đồng/lượng sáng nay",
    }),
  ]);
  const ok = validateExtractedClaims(
    {
      claims: [
        {
          subject: "giá vàng",
          predicate: "gold_price",
          value: "90 triệu đồng/lượng",
          label: "Giá vàng 90 triệu",
          source: "VnExpress",
        },
        {
          subject: "ma",
          predicate: "ghost_seen",
          value: "1",
          label: "hallucinated",
          source: "FakeSource",
        },
        {
          subject: "giá vàng",
          predicate: "gold_price",
          value: "999 triệu",
          label: "not in corpus",
          source: "VnExpress",
        },
      ],
    },
    c,
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0].claimKey, "gia_vang|gold_price");
  assert.equal(ok[0].method, "model");
  assert.equal(ok[0].assertedBy, "VnExpress");
});
