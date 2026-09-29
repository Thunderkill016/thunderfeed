/**
 * R7.1d.3b.1 — doc-level resolver attachment provenance. Every
 * event_evidence edge must trace to the resolver_decisions row that
 * created it, carrying the pair features + PRE-DECISION candidate
 * signature the resolver actually saw (signature-poisoning forensics).
 * Founding docs of a created event get an explicit create_new_event
 * path — never the generic attached_by='semantic' bucket.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import { persistCluster, type ExtractedClaim } from "../lib/db/writer";
import { repHash } from "../lib/resolver";
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

function article(
  title: string,
  opts: {
    summary?: string;
    language?: "vi" | "en";
    source?: string;
    publishedAt?: string;
  } = {},
): Article {
  return {
    id: randomUUID(),
    title,
    summary: opts.summary ?? "",
    url: `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: opts.publishedAt ?? new Date().toISOString(),
    source: opts.source ?? "VnExpress",
    topic: "world",
    headline: false,
    appearances: [],
    language: opts.language ?? "vi",
  };
}

function cluster(
  title: string,
  opts: {
    summary?: string;
    language?: "vi" | "en";
    source?: string;
    publishedAt?: string;
    extraArticles?: Article[];
  } = {},
): StoryCluster {
  const a = article(title, opts);
  return {
    id: `rc-${randomUUID().slice(0, 8)}`,
    title,
    summary: a.summary,
    leadArticle: a,
    articles: [a, ...(opts.extraArticles ?? [])],
    sources: [
      { name: a.source, url: a.url },
      ...(opts.extraArticles ?? []).map((x) => ({
        name: x.source,
        url: x.url,
      })),
    ],
    topic: "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: a.publishedAt,
  };
}

interface ProvRow {
  evidence_version_id: string;
  resolver_decision_id: string;
  decision: string;
  path: string;
  incoming_cluster: string;
  candidate_event_id: string | null;
  lexical_score: number | null;
  entity_score: number | null;
  generic_claim_overlap: number | null;
  rare_tokens: string[];
  shared_entities: string[];
  shared_nonhub_entities: string[];
  cross_language: boolean | null;
  candidate_signature_hash_before: string | null;
  candidate_entity_count_before: number | null;
  candidate_entities_before: string[] | null;
  candidate_core_entities_before: string[] | null;
  incoming_entities: string[] | null;
  incoming_core_entities: string[] | null;
  explanation: Record<string, unknown>;
}

async function provenanceFor(eventId: string): Promise<ProvRow[]> {
  const r = await getPool().query<ProvRow>(
    `SELECT * FROM event_attachment_provenance
     WHERE event_id = $1 ORDER BY created_at, evidence_version_id`,
    [eventId],
  );
  return r.rows;
}

async function eventSig(eventId: string): Promise<string> {
  const r = await getPool().query<{ entity_signature: string }>(
    `SELECT entity_signature FROM events WHERE id = $1`,
    [eventId],
  );
  return r.rows[0].entity_signature;
}

/* ------------------------------ test cases ------------------------------ */

test("new event: founding doc provenance is create_new_event, not semantic", async () => {
  setupDb();
  const r = await persistCluster(
    cluster("Bão hình thành ngoài khơi miền Trung"),
    [],
  );
  const prov = await provenanceFor(r.eventId);
  assert.equal(prov.length, 1);
  assert.equal(prov[0].path, "create_new_event");
  assert.equal(prov[0].decision, "create");
  assert.equal(prov[0].candidate_event_id, null);
  // no candidate existed — pre-merge sets stay NULL (distinct from a
  // verified-empty set), incoming sets always captured
  assert.equal(prov[0].candidate_entities_before, null);
  assert.ok(Array.isArray(prov[0].incoming_entities));
  // the provenance FK lands on a real resolver_decisions row
  const d = await getPool().query(
    `SELECT decision, path, chosen_event_id FROM resolver_decisions
     WHERE id = $1`,
    [prov[0].resolver_decision_id],
  );
  assert.equal(d.rows[0].decision, "create");
  assert.equal(d.rows[0].path, "create_new_event");
  assert.equal(d.rows[0].chosen_event_id, r.eventId);
});

test("headline merge: provenance carries path + pre-merge signature", async () => {
  setupDb();
  const ra = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", { source: "VnExpress" }),
    [],
  );
  const sigBefore = await eventSig(ra.eventId);
  const rb = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", { source: "Tuổi Trẻ" }),
    [],
  );
  assert.equal(rb.eventId, ra.eventId);
  const prov = await provenanceFor(ra.eventId);
  assert.equal(prov.length, 2);
  const merged = prov.find((p) => p.decision === "merge")!;
  assert.equal(merged.path, "headline");
  assert.equal(merged.candidate_event_id, ra.eventId);
  assert.equal(
    merged.candidate_signature_hash_before,
    repHash(sigBefore),
    "stored hash must equal the signature BEFORE this merge accumulated",
  );
  assert.ok((merged.candidate_entity_count_before ?? 0) > 0);
  // actual pre-merge entity SET persisted — the stable-anchor
  // counterfactual replays membership, not just cardinality
  assert.deepEqual(
    merged.candidate_entities_before,
    sigBefore.split(" ").filter(Boolean).sort(),
  );
  assert.equal(merged.lexical_score, 1);
  assert.equal(merged.cross_language, false);
  // founding doc keeps its create edge — attribution is never rewritten
  const founding = prov.find((p) => p.decision === "create")!;
  assert.equal(founding.path, "create_new_event");
});

test("cluster of N docs: every attached edge links to the SAME decision", async () => {
  setupDb();
  const a2 = article("Ông Tập lên đường thăm Mỹ", {
    source: "Tuổi Trẻ",
  });
  const a3 = article("Ông Tập lên đường thăm Mỹ", { source: "Thanh Niên" });
  const r = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", {
      source: "VnExpress",
      extraArticles: [a2, a3],
    }),
    [],
  );
  const prov = await provenanceFor(r.eventId);
  assert.equal(prov.length, 3);
  assert.equal(
    new Set(prov.map((p) => p.resolver_decision_id)).size,
    1,
    "one decision → N provenance edges, not N decisions",
  );
  assert.equal(prov[0].path, "create_new_event");

  // a merging multi-doc cluster likewise shares ONE merge decision
  const b2 = article("Ông Tập lên đường thăm Mỹ", { source: "Dân Trí" });
  const rb = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", {
      source: "VTV",
      extraArticles: [b2],
    }),
    [],
  );
  assert.equal(rb.eventId, r.eventId);
  const prov2 = await provenanceFor(r.eventId);
  assert.equal(prov2.length, 5);
  const mergeEdges = prov2.filter((p) => p.decision === "merge");
  assert.equal(mergeEdges.length, 2);
  assert.equal(new Set(mergeEdges.map((p) => p.resolver_decision_id)).size, 1);
});

test("generic_claim merge: path recorded on the provenance edge", async () => {
  setupDb();
  // two phrasings of one incident, no entities on either side — the
  // identical claim fingerprint is the only merge path (resolver
  // regression fixture)
  const mk = (title: string, source: string, value: unknown) => {
    const c = cluster(title, {
      source,
      publishedAt: "2026-09-24T08:00:00Z",
    });
    const claims: ExtractedClaim[] = [
      {
        claimKey: "deaths",
        predicate: "deaths",
        valueType: "number",
        value,
        unit: "people",
        label: "Số người thiệt mạng",
        assertedBy: source,
        articleId: c.articles[0].id,
        assertedAt: c.articles[0].publishedAt,
      },
    ];
    return { c, claims };
  };
  const a = mk("Cháy kho lớn: 20 người thiệt mạng", "VnExpress", 20);
  const ra = await persistCluster(a.c, a.claims);
  const b = mk("Hỏa hoạn nhà kho, số người chết lên đến 20", "Tuổi Trẻ", "20");
  const rb = await persistCluster(b.c, b.claims);
  assert.equal(rb.eventId, ra.eventId);
  const merged = (await provenanceFor(ra.eventId)).find(
    (p) => p.decision === "merge",
  )!;
  assert.equal(merged.path, "generic_claim");
  assert.equal(merged.generic_claim_overlap, 1);
});

test("rare_token merge: exact shared rare tokens persisted", async () => {
  setupDb();
  // invented product names — no gazetteer entities; 'astralix'/'zentra'
  // are ≥5-char non-excluded tokens, jaccard ~0.4 lands on rare_token
  const ra = await persistCluster(
    cluster("Astralix công bố chip Zentra tại Hà Nội"),
    [],
  );
  const rb = await persistCluster(
    cluster("Astralix công bố giá Zentra mới", { source: "Tuổi Trẻ" }),
    [],
  );
  assert.equal(rb.eventId, ra.eventId);
  const merged = (await provenanceFor(ra.eventId)).find(
    (p) => p.decision === "merge",
  )!;
  assert.equal(merged.path, "rare_token");
  const toks = new Set(merged.rare_tokens);
  assert.ok(
    toks.has("astralix") && toks.has("zentra"),
    JSON.stringify([...toks]),
  );
});

test("cross_lingual merge: shared non-hub entities persisted", async () => {
  setupDb();
  // vi candidate carries 5 core entities, en incoming shares only
  // {federal_reserve, us} — coreSim 0.4 lands below the entity-strong
  // band and inside the cross_lingual band; near-zero lexical overlap
  const ra = await persistCluster(
    cluster("Fed, Mỹ, ECB, Nato, Nhật đạt thỏa thuận chung", {
      language: "vi",
    }),
    [],
  );
  const rb = await persistCluster(
    cluster("Fed, US reach surprise deal", {
      language: "en",
      source: "Reuters",
    }),
    [],
  );
  assert.equal(rb.eventId, ra.eventId);
  const merged = (await provenanceFor(ra.eventId)).find(
    (p) => p.decision === "merge",
  )!;
  assert.equal(merged.path, "cross_lingual");
  assert.ok(
    merged.shared_nonhub_entities.includes("federal_reserve"),
    JSON.stringify(merged.shared_nonhub_entities),
  );
  assert.equal(merged.cross_language, true);
});

test("semantic_xlang merge: lexical + entity scores persisted", async () => {
  setupDb();
  // cosine steered into the xlang band (0.8); embedder is shape-keyed:
  // a 1-text call is always a candidate/incoming rep rep embed → cand,
  // a multi-text call is warmup [incRep, ...missing] → [inc, cand]
  const inc = [1, 0, 0];
  const cand = [0.8, Math.sqrt(0.36), 0]; // cosine(inc, cand) = 0.8
  const embedder = async (texts: string[]) =>
    texts.length === 1 ? [cand] : [inc, ...texts.slice(1).map(() => cand)];
  const ra = await persistCluster(
    cluster("Fed cắt giảm lãi suất lần thứ ba", { language: "vi" }),
    [],
    { embedder },
  );
  const rb = await persistCluster(
    cluster("Federal Reserve cuts interest rates a third time", {
      language: "en",
      source: "Reuters",
    }),
    [],
    { embedder },
  );
  assert.equal(rb.eventId, ra.eventId);
  const merged = (await provenanceFor(ra.eventId)).find(
    (p) => p.decision === "merge",
  )!;
  assert.equal(merged.path, "semantic_xlang");
  assert.equal(merged.cross_language, true);
  assert.equal(typeof merged.lexical_score, "number");
  assert.equal(typeof merged.entity_score, "number");
  assert.ok(
    typeof (merged.explanation as { semanticSimilarity?: unknown })
      .semanticSimilarity === "number",
  );
});

test("mid-tx failure propagates — persist rejects, never swallows", async () => {
  setupDb();
  // a circular claim value throws when the claims phase serializes it —
  // after evidence attach, inside the same transaction. On real
  // Postgres the enclosing tx rolls back atomically; pg-mem pool
  // clients do not physically roll back, so this test pins the contract
  // (rejection reaches the caller) while the physical-undo guarantee is
  // exercised by the forced-telemetry-failure tests + verified live.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const c = cluster("Tàu sân bay cập cảng Đà Nẵng");
  await assert.rejects(
    persistCluster(c, [
      {
        claimKey: "loop",
        predicate: "loop",
        valueType: "json",
        value: circular,
        label: "x",
        assertedBy: "VnExpress",
        articleId: c.articles[0].id,
      },
    ]),
  );
  const provCount = (
    await getPool().query<{ c: number }>(
      `SELECT count(*)::int AS c FROM event_attachment_provenance`,
    )
  ).rows[0].c;
  assert.equal(provCount, 0, "a failed cluster leaves no provenance edge");
});

test("idempotent re-attach: already-attached doc gains no duplicate edge", async () => {
  setupDb();
  const c = cluster("Ông Tập lên đường thăm Mỹ");
  const r1 = await persistCluster(c, []);
  const r2 = await persistCluster(c, []);
  assert.equal(r2.eventId, r1.eventId);
  const prov = await provenanceFor(r1.eventId);
  assert.equal(prov.length, 1, "re-persist must not duplicate edges");
});

/** route a failing match through the injected pool — wraps every
 *  checked-out client so one targeted INSERT throws inside the tx.
 *  Returns a trace of the SQL statements the client issued so tests can
 *  pin ordering: evidence attach BEFORE the failing telemetry write,
 *  ROLLBACK after. (pg-mem pool clients do not physically roll back —
 *  physical undo is verified once against real Postgres; here we pin
 *  the fail-closed CONTRACT: the error propagates and the abort path
 *  runs, never a swallowed COMMIT.) */
function failOn(match: RegExp) {
  const pool = getPool();
  const issued: string[] = [];
  const origConnect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const c = await origConnect();
    const orig = c.query.bind(c);
    c.query = ((text: unknown, params?: unknown) => {
      const sql = typeof text === "string" ? text : "";
      const head = sql.trim().split(/\s+/).slice(0, 3).join(" ");
      issued.push(head);
      if (match.test(sql))
        return Promise.reject(new Error("forced telemetry failure"));
      return orig(text as never, params as never);
    }) as typeof c.query;
    return c;
  }) as typeof pool.connect;
  return issued;
}

test("winner decision insert failure: rejects, never a swallowed COMMIT", async () => {
  setupDb();
  // the anchor insert is the only resolver_decisions write carrying
  // RETURNING — bulk pair telemetry is SELECT..unnest and stays
  // best-effort by design
  const issued = failOn(/INSERT INTO resolver_decisions[\s\S]*RETURNING/);
  await assert.rejects(
    persistCluster(cluster("Tàu sân bay cập cảng"), []),
    /forced telemetry failure/,
  );
  assert.ok(
    issued.includes("ROLLBACK"),
    "anchor failure must abort the persist tx",
  );
  assert.ok(!issued.includes("COMMIT"));
});

test("provenance insert failure after event_evidence: tx aborts", async () => {
  setupDb();
  const issued = failOn(/INSERT INTO event_attachment_provenance/);
  await assert.rejects(
    persistCluster(cluster("Tàu sân bay cập cảng"), []),
    /forced telemetry failure/,
  );
  const eeAt = issued.findIndex((s) =>
    s.startsWith("INSERT INTO event_evidence"),
  );
  const rbAt = issued.indexOf("ROLLBACK");
  assert.ok(eeAt > -1, "the evidence attach ran before the failure");
  assert.ok(rbAt > eeAt, "rollback must follow the failed provenance");
  assert.ok(!issued.includes("COMMIT"));
});

test("pre-decision signature stays frozen across later merges", async () => {
  setupDb();
  const ra = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", { source: "VnExpress" }),
    [],
  );
  const sigA = await eventSig(ra.eventId);
  // B adds "Nhật Bản" — the merge union expands entity_signature, and
  // the NEXT merge's provenance must carry the expanded pre-state
  await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ, ghé Nhật Bản", {
      source: "Tuổi Trẻ",
    }),
    [],
  );
  const sigAfterB = await eventSig(ra.eventId);
  assert.notEqual(sigAfterB, sigA, "fixture must actually expand sig");
  const rc = await persistCluster(
    cluster("Ông Tập lên đường thăm Mỹ", { source: "Thanh Niên" }),
    [],
  );
  assert.equal(rc.eventId, ra.eventId);
  const merges = (await provenanceFor(ra.eventId)).filter(
    (p) => p.decision === "merge",
  );
  assert.equal(merges.length, 2);
  const [first, second] = merges;
  assert.equal(
    first.candidate_signature_hash_before,
    repHash(sigA),
    "first merge must store the founding signature",
  );
  assert.equal(
    second.candidate_signature_hash_before,
    repHash(sigAfterB),
    "second merge must store the signature AFTER the first union",
  );
  assert.notEqual(
    first.candidate_signature_hash_before,
    second.candidate_signature_hash_before,
    "accumulation must not retro-rewrite earlier provenance",
  );
});
