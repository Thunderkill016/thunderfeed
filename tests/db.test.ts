/**
 * Writer/read layer integration test against pg-mem (in-memory Postgres).
 * Runs the real migration minus the pgcrypto/plpgsql bits pg-mem can't host,
 * then exercises the full persist → diff → project pipeline.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import { persistCluster } from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import { getEventView, getLatestChanges } from "../lib/db/read";
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

test("persistCluster → EventView → claim diff → change log", async () => {
  setupDb();

  const c1 = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
    art({
      source: "BBC World News",
      title: "Storm grounds travel — 20 flights cancelled",
      language: "en",
    }),
  ]);

  // first persist: creates event + claim v1 + event_created change
  const r1 = await persistCluster(c1, extractClaims(c1));
  assert.ok(r1.created);
  assert.equal(r1.evidenceAttached, 2);
  assert.equal(r1.changes.length, 1); // new_claim

  const view1 = await getEventView(r1.eventId);
  assert.ok(view1);
  assert.equal(view1.claims.length, 1);
  assert.equal(view1.claims[0].value, 20);
  assert.equal(view1.claims[0].state, "reported");
  assert.equal(view1.evidence.publishers.length, 2);

  // second persist: same articles (re-observation) + same claim → no change
  const r2 = await persistCluster(c1, extractClaims(c1));
  assert.ok(!r2.created); // signature match → same event
  assert.equal(r2.changes.length, 0); // nothing material

  // third persist: a NEW outlet asserts a different value → dispute,
  // not a silent overwrite (spec: Nguồn A=20, Nguồn B=35 → claim_disputed)
  const c3 = cluster([
    art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
    art({
      source: "BBC World News",
      title: "Storm grounds travel — 20 flights cancelled",
      language: "en",
    }),
    art({ source: "Tuổi Trẻ", title: "Bão lớn: 35 chuyến bay bị hủy" }),
  ]);
  // give the new article a different url (it is a new document)
  c3.articles[2].url = "https://tuoitre.vn/storm-35";
  const r3 = await persistCluster(c3, extractClaims(c3));
  assert.equal(r3.changes.length, 1);
  assert.match(r3.changes[0], /20.*35/);

  const view3 = await getEventView(r1.eventId);
  assert.ok(view3);
  const claim = view3.claims.find((c) => c.predicate === "flights_cancelled")!;
  assert.equal(claim.value, 35);
  assert.equal(claim.state, "disputed");
  assert.equal(claim.previousValue, 20); // the "20 → 35" diff is served
  assert.equal(view3.confidence.contradictions, 1);

  const feed = await getLatestChanges();
  const types = feed.map((f) => f.type);
  assert.ok(types.includes("claim_disputed"));
  assert.ok(types.includes("event_created"));
  // non-material persist (r2) must NOT appear as a change
  assert.equal(feed.filter((f) => f.type === "new_coverage").length, 0);
});

test("same document with changed content appends a new evidence_version", async () => {
  setupDb();
  const pool = getPool();

  const v1Cluster = cluster([
    art({
      source: "VnExpress",
      url: "https://x.vn/doc",
      title: "Bão lớn: 20 chuyến bay bị hủy",
    }),
  ]);
  await persistCluster(v1Cluster, extractClaims(v1Cluster));

  // same URL, title changed → v2 with a supersedes link back to v1
  const v2Cluster = cluster([
    art({
      source: "VnExpress",
      url: "https://x.vn/doc",
      title: "Bão lớn: 35 chuyến bay bị hủy",
    }),
  ]);
  await persistCluster(v2Cluster, extractClaims(v2Cluster));

  const { rows: versions } = await pool.query<{
    version_no: number;
    title: string;
    supersedes_version_id: string | null;
  }>(
    `SELECT version_no, title, supersedes_version_id
     FROM evidence_versions ORDER BY version_no`,
  );
  assert.equal(versions.length, 2);
  assert.match(versions[0].title, /20/);
  assert.match(versions[1].title, /35/);
  assert.ok(versions[1].supersedes_version_id, "v2 links back to v1");

  // re-observing identical content appends NOTHING — still 2 versions
  await persistCluster(v2Cluster, extractClaims(v2Cluster));
  const { rows: again } = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM evidence_versions`,
  );
  assert.equal(Number(again[0].c), 2);
});

/**
 * THE acceptance case for the change engine:
 *   09:00 Reuters "20 chuyến bay bị hủy"   → event + claim v1
 *   09:20 BBC repeats the same fact       → new_coverage, NOT material
 *   10:15 official agency "35 chuyến bay" → claim_updated 20→35 + primary evidence
 * One event, one claim, two claim versions, and the UI can say
 * "UPDATED — 20 → 35 sau khi nguồn chính thức công bố."
 */
test("acceptance: coverage is not change; primary source updates the claim", async () => {
  setupDb();
  const pool = getPool();

  // 09:00 — Reuters first report
  const t0900 = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(t0900, extractClaims(t0900));
  assert.ok(r1.created);

  // 09:20 — BBC repeats the same fact in English
  const t0920 = cluster([
    art({
      source: "BBC World News",
      title: "Storm grounds travel — 20 flights cancelled",
      language: "en",
    }),
  ]);
  const r2 = await persistCluster(t0920, extractClaims(t0920));
  assert.equal(r2.eventId, r1.eventId, "same facts → same event");

  // one logical claim still, still on v1 — coverage must not mint a version
  const { rows: claimRows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM claims`,
  );
  assert.equal(Number(claimRows[0].c), 1);

  // 10:15 — the official agency revises the number upward
  const t1015 = cluster([
    art({
      source: "Cục Hàng không",
      title: "Bão lớn: 35 chuyến bay bị hủy",
    }),
  ]);
  const r3 = await persistCluster(t1015, extractClaims(t1015), {
    sourceMeta: { "Cục Hàng không": { kind: "primary" } },
  });
  assert.equal(r3.eventId, r1.eventId);

  // exactly 2 claim versions: 20 then 35
  const { rows: cvs } = await pool.query<{
    version_no: number;
    value: number;
  }>(`SELECT version_no, value FROM claim_versions ORDER BY version_no`);
  assert.equal(cvs.length, 2);
  assert.equal(cvs[0].value, 20);
  assert.equal(cvs[1].value, 35);

  // the full change log — new_coverage exists but is low materiality
  const { rows: allChanges } = await pool.query<{
    type: string;
    materiality: string;
  }>(`SELECT type, materiality FROM changes ORDER BY detected_at`);
  const types = allChanges.map((c) => c.type);
  assert.ok(types.includes("new_coverage"));
  assert.equal(
    allChanges.find((c) => c.type === "new_coverage")?.materiality,
    "low",
  );
  assert.ok(types.includes("claim_updated"));
  assert.ok(types.includes("new_primary_source"));

  // coverage created NO event_version — versions only from material change:
  // v1 event_created, v2 new_claim, v3 claim_updated, v4 primary_confirmation
  const { rows: evs } = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM event_versions`,
  );
  assert.equal(Number(evs[0].c), 4);

  // stances: Reuters supports v1; the agency originates v2
  const { rows: stances } = await pool.query<{
    version_no: number;
    stance: string;
  }>(
    `SELECT cv.version_no, ce.stance
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     ORDER BY cv.version_no, ce.stance`,
  );
  assert.deepEqual(
    stances.map((s) => [s.version_no, s.stance]),
    [
      [1, "supports"], // Reuters asserts it
      [1, "supports"], // BBC corroborates the same value
      [2, "originates"], // the agency's evidence originates v2
    ],
  );

  // EventView serves the UI sentence directly
  const view = await getEventView(r1.eventId);
  assert.ok(view);
  assert.equal(view.claims.length, 1);
  assert.equal(view.claims[0].value, 35);
  assert.equal(view.claims[0].previousValue, 20);
  assert.equal(view.evidence.primary.length, 1);
  // the per-event timeline is complete — coverage appears, flagged low,
  // while the cross-event feed (getLatestChanges) filters it out
  const cov = view.latestChanges.find((c) => c.type === "new_coverage");
  assert.ok(cov, "coverage is on the event timeline");
  assert.equal(cov.materiality, "low");
  const upd = view.latestChanges.find((c) => c.type === "claim_updated");
  assert.ok(upd);
  assert.equal(upd.materiality, "high");
});
