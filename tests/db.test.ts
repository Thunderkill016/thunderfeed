/**
 * Writer/read layer integration test against pg-mem (in-memory Postgres).
 * Runs the real migration minus the pgcrypto/plpgsql bits pg-mem can't host,
 * then exercises the full persist → diff → project pipeline.
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
import {
  getEventView,
  getLatestChanges,
  getEntityEvents,
} from "../lib/db/read";
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
  // claim_disputed + new_independent_evidence (Tuổi Trẻ is a new origin)
  assert.equal(r3.changes.length, 2);
  assert.ok(r3.changes.some((s) => /20.*35/.test(s)));

  const view3 = await getEventView(r1.eventId);
  assert.ok(view3);
  const claim = view3.claims.find((c) => c.predicate === "flights_cancelled")!;
  // positions model: the majority position stands as truth — 20 has two
  // supporters vs one for 35; the claim reads disputed, not flipped
  assert.equal(claim.value, 20);
  assert.equal(claim.state, "disputed");
  assert.equal(view3.confidence.contradictions, 1);
  assert.deepEqual(
    claim.positions?.map((p) => [p.value, p.sources]),
    [
      [20, ["VnExpress", "BBC World News"]],
      [35, ["Tuổi Trẻ"]],
    ],
  );

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
  // BBC is a new INDEPENDENT origin under lineage semantics — material
  // corroboration, not low-grade syndicated coverage
  assert.ok(types.includes("new_independent_evidence"));
  assert.equal(
    allChanges.find((c) => c.type === "new_independent_evidence")?.materiality,
    "medium",
  );
  assert.ok(types.includes("claim_updated"));
  assert.ok(types.includes("new_primary_source"));

  // batched EventVersion: one snapshot per observation cycle —
  // v1 = creation (event_created + new_claim annotate it),
  // v2 = BBC independent corroboration (independent_origin),
  // v3 = the official-source cycle (claim_updated + primary_confirmation)
  const { rows: evs } = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM event_versions`,
  );
  assert.equal(Number(evs[0].c), 3);

  // all material changes in one cycle point at the same snapshot
  // (creation-cycle changes annotate v1 and carry no from_version)
  const { rows: matChanges } = await pool.query<{
    type: string;
    to_event_version_id: string;
  }>(
    `SELECT type, to_event_version_id FROM changes
      WHERE materiality != 'low' AND from_event_version_id IS NOT NULL
      ORDER BY type`,
  );
  const matTypes = matChanges.map((c) => c.type);
  assert.ok(matTypes.includes("claim_updated"));
  assert.ok(matTypes.includes("new_primary_source"));
  assert.ok(matTypes.includes("new_independent_evidence"));
  // two material cycles → two distinct snapshots, each cycle's changes
  // pointing at exactly one version
  assert.equal(
    new Set(matChanges.map((c) => c.to_event_version_id)).size,
    2,
    "one EventVersion per observation cycle",
  );

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
  // the per-event timeline is complete — BBC's independent corroboration
  // appears as medium materiality under lineage semantics
  const ind = view.latestChanges.find(
    (c) => c.type === "new_independent_evidence",
  );
  assert.ok(ind, "independent corroboration is on the event timeline");
  assert.equal(ind.materiality, "medium");
  const upd = view.latestChanges.find((c) => c.type === "claim_updated");
  assert.ok(upd);
  assert.equal(upd.materiality, "high");
});

test("two display names sharing one domain attach to one source row", async () => {
  // regression: upsert used to ON CONFLICT (name) only — a second name
  // resolving to an already-owned domain crashed on uq_sources_domain and
  // aborted the cluster's transaction.
  setupDb();
  const meta = (n: string) => ({
    [n]: { domain: "shared.example" },
  });
  const c1 = cluster([
    art({ source: "Alpha News", url: "https://shared.example/a1" }),
  ]);
  await persistCluster(c1, extractClaims(c1), {
    sourceMeta: meta("Alpha News"),
  });
  const c2 = cluster([
    art({
      source: "Beta News",
      url: "https://shared.example/b2",
      title: "entirely different story words no overlap",
    }),
  ]);
  await persistCluster(c2, extractClaims(c2), {
    sourceMeta: meta("Beta News"),
  });
  const { rows } = await getPool().query<{ name: string; domain: string }>(
    `SELECT name, domain FROM sources WHERE domain = 'shared.example'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Alpha News");
});

test("null-domain name row gets its domain backfilled, never stolen", async () => {
  setupDb();
  // first sighting carries no domain hint → name row with NULL domain
  const c1 = cluster([
    art({ source: "Gamma Daily", url: "https://g.example/g1" }),
  ]);
  await persistCluster(c1, extractClaims(c1), {
    sourceMeta: { "Gamma Daily": {} },
  });
  // later sighting resolves the registry domain → backfill onto same row
  const c2 = cluster([
    art({
      source: "Gamma Daily",
      url: "https://g.example/g2",
      title: "another distinct headline with unique wording",
    }),
  ]);
  await persistCluster(c2, extractClaims(c2), {
    sourceMeta: { "Gamma Daily": { domain: "g.example" } },
  });
  const { rows } = await getPool().query<{ domain: string | null }>(
    `SELECT domain FROM sources WHERE name = 'Gamma Daily'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "g.example");
});

test("event_entities junction: create, accumulate on merge, entity reads", async () => {
  setupDb();

  // an event naming the US + China in its title carries both slugs;
  // the summary mentions the Philippines in passing — headline tier
  // (entity_signature_core) must NOT pick it up
  const c1 = cluster([
    art({
      source: "VnExpress",
      title: "Mỹ công bố thỏa thuận thương mại với Trung Quốc",
      summary: "Thỏa thuận được Philippines quan tâm theo dõi sát.",
    }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  assert.ok(r1.created);

  // junction rows mirror the event's canonical signature
  const us = await getEntityEvents("us");
  assert.deepEqual(
    us.events.map((e) => e.id),
    [r1.eventId],
  );
  const cn = await getEntityEvents("china");
  assert.deepEqual(
    cn.events.map((e) => e.id),
    [r1.eventId],
  );
  const jp = await getEntityEvents("japan");
  assert.equal(jp.events.length, 0);

  // typed registry rides along: us is a place, china too — and each sees
  // the other through the co-occurrence edge
  assert.equal(us.kind, "place");
  assert.equal(cn.kind, "place");
  // headline tier: title actors headline, summary mentions stay peripheral
  assert.equal(us.events[0].inTitle, true);
  assert.equal(cn.events[0].inTitle, true);
  const ph = await getEntityEvents("philippines");
  assert.equal(
    ph.events[0]?.inTitle,
    false,
    "passing mention stays peripheral",
  );
  assert.deepEqual(
    us.related.coOccurrence.map((r) => r.slug),
    ["china", "philippines"],
    "even a mention-tier slug joins the co-occurrence edge",
  );

  // a later observation of the SAME story whose LEAD also names Japan
  // merges — the signature accumulates and the junction gains the slug
  const c2 = cluster([
    art({
      source: "VnExpress",
      title:
        "Mỹ công bố thỏa thuận thương mại với Trung Quốc, Nhật Bản hoan nghênh",
    }),
    art({
      source: "BBC World News",
      title: "US-China trade deal announced, Japan welcomes it",
      language: "en",
    }),
  ]);
  const r2 = await persistCluster(c2, extractClaims(c2));
  assert.equal(r2.eventId, r1.eventId, "same story attaches, not a split");

  const jp2 = await getEntityEvents("japan");
  assert.deepEqual(
    jp2.events.map((e) => e.id),
    [r1.eventId],
    "entity rows accumulate like the signature",
  );

  // merge accumulated japan — us's neighbourhood now spans three, and
  // japan anchored a merged title so it upgrades to headline tier
  const us2 = await getEntityEvents("us");
  assert.deepEqual(
    us2.related.coOccurrence.map((r) => r.slug).sort(),
    ["china", "japan", "philippines"],
    "co-occurrence edge accumulates with the signature",
  );
  assert.equal(
    jp2.events[0].inTitle,
    true,
    "a slug promoted into the merged core signature headlines",
  );

  // upgrade path: a third observation anchors the Philippines in its
  // title — the existing junction row promotes mention → headline
  const c3 = cluster([
    art({
      source: "VnExpress",
      title:
        "Mỹ công bố thỏa thuận thương mại với Trung Quốc, Philippines hoan nghênh",
    }),
  ]);
  const r3 = await persistCluster(c3, extractClaims(c3));
  assert.equal(r3.eventId, r1.eventId, "same story still attaches");
  const ph2 = await getEntityEvents("philippines");
  assert.equal(
    ph2.events[0].inTitle,
    true,
    "headline promotion upgrades the row, never demotes",
  );

  // the watch-topic read path (junction-backed) returns the same event's
  // changes an exploded-signature query would have found
  const { getChangesForEntities } = await import("../lib/db/read");
  const watched = await getChangesForEntities(["japan"]);
  assert.ok(
    watched.some((c) => c.eventId === r1.eventId),
    "watching 'japan' surfaces this event's changes",
  );
});

test("pgSsl: loopback plaintext, supabase pinned-CA verify, unknown remote rejects insecure", async () => {
  const { pgSsl, SUPABASE_POOLER_CA } = await import("../lib/db/supabaseCa");
  // Local dev: no TLS at all
  assert.equal(pgSsl("postgres://x@127.0.0.1:5432/db"), undefined);
  assert.equal(pgSsl("postgres://x@localhost/db"), undefined);
  // Supabase pooler/host: verify-full with the pinned CA chain — never
  // rejectUnauthorized:false (that was the MITM-hole config).
  const sb = pgSsl("postgres://x@aws-0-x.pooler.supabase.com:6543/postgres");
  assert.equal(sb?.rejectUnauthorized, true);
  assert.equal(sb?.ca, SUPABASE_POOLER_CA);
  const sb2 = pgSsl("postgres://x@db.abcdef.supabase.co/postgres");
  assert.equal(sb2?.rejectUnauthorized, true);
  // Unknown remote host: still verify (fail closed, no silent plaintext)
  const other = pgSsl("postgres://x@db.example.com/postgres");
  assert.equal(other?.rejectUnauthorized, true);
});

test("provider outage: dead pool makes persistEdition throw, never fake-success", async () => {
  // DATABASE_URL set so dbEnabled() is true; the injected pool refuses
  // every connection — persist must propagate, not report {persisted:0}.
  process.env.DATABASE_URL = "postgres://x@127.0.0.1:5432/db";
  const deadPool = {
    connect: () => Promise.reject(new Error("connection refused")),
    query: () => Promise.reject(new Error("connection refused")),
  };
  injectPool(deadPool as unknown as Pool);
  try {
    const { persistEdition } = await import("../lib/db/persist");
    await assert.rejects(
      persistEdition([cluster([art({})])], new Map()),
      /connection refused/,
    );
  } finally {
    injectPool(null);
    delete process.env.DATABASE_URL;
  }
});
