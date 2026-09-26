/**
 * Canonical identity regression tests — the durable foundation the
 * gazetteer slugs resolve into. Covers the mission's required cases:
 * alias resolution, person/company separation, slug compatibility,
 * junction backfill, co-occurrence ≠ relationship, relationship
 * history, and evidence-level mention provenance.
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
  dedupeEntityRows,
  evidenceEntityAssertions,
} from "../lib/db/writer";
import {
  planEvidenceReconciliation,
  applyEvidencePlan,
} from "../lib/db/reconcile";
import { entityHref } from "../lib/entities";
import { extractClaims } from "../lib/db/extract";
import {
  getEntityEvents,
  getEventView,
  getChangesForEntities,
  resolveEntityRef,
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
    ingest: over.ingest,
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

/** entity_id → canonical_key lookup for assertion-shape tests */
const keyById = new Map<string, string>();
async function loadKeys() {
  const { rows } = await getPool().query<{ id: string; key: string }>(
    `SELECT id, canonical_key key FROM entities`,
  );
  keyById.clear();
  for (const r of rows) keyById.set(r.id, r.key);
}

test("identity resolution: Fed aliases all land on one canonical entity", async () => {
  setupDb();
  const c = cluster([
    art({
      source: "VnExpress",
      title: "FED giữ nguyên lãi suất trong bối cảnh Mỹ và Trung Quốc",
    }),
    art({
      source: "BBC World News",
      title: "Federal Reserve Board holds rates steady",
      language: "en",
    }),
  ]);
  const r = await persistCluster(c, extractClaims(c));
  assert.ok(r.created);

  // the legacy slug resolves to the canonical central-bank entity
  const fed = await getEntityEvents("federal_reserve");
  assert.equal(fed.entity?.canonicalKey, "central_bank:fed");
  assert.equal(fed.entity?.type, "central_bank");
  assert.equal(fed.label, "Federal Reserve");
  assert.deepEqual(
    fed.events.map((e) => e.id),
    [r.eventId],
  );

  // Fed / Federal Reserve / Federal Reserve Board → same entity
  const viaSlug = await resolveEntityRef("federal_reserve");
  const viaKey = await resolveEntityRef("central_bank:fed");
  const viaName = await resolveEntityRef("Federal Reserve");
  const viaBoard = await resolveEntityRef("Federal Reserve Board");
  for (const v of [viaKey, viaName, viaBoard]) assert.equal(v?.id, viaSlug?.id);

  // junction rows carry the canonical id — no row left without one
  const dangling = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM event_entities WHERE entity_id IS NULL`,
  );
  assert.equal(dangling.rows[0].n, 0, "every junction row is canonical");

  // EventView entity chips expose the durable identity, not just text
  const view = await getEventView(r.eventId);
  const fedChip = view?.entities.find((e) => e.slug === "federal_reserve");
  assert.equal(fedChip?.entityId, viaSlug?.id);
  assert.equal(fedChip?.canonicalKey, "central_bank:fed");
  assert.equal(fedChip?.type, "central_bank");

  // watch compatibility: a stored slug still returns its events' changes
  const changes = await getChangesForEntities(["federal_reserve"]);
  assert.ok(
    changes.some((ch) => ch.eventId === r.eventId),
    "slug-based watch keeps working through canonical resolution",
  );
});

test("person/company separation: Tesla company never bleeds into Elon Musk", async () => {
  setupDb();
  const cTesla = cluster([
    art({ source: "Reuters", title: "Tesla announces record deliveries" }),
  ]);
  const rTesla = await persistCluster(cTesla, extractClaims(cTesla));
  const tesla = await getEntityEvents("tesla");
  assert.equal(tesla.entity?.canonicalKey, "company:tesla");
  assert.equal(tesla.entity?.type, "company");
  assert.equal(tesla.label, "Tesla, Inc.", "never displays as Elon Musk");

  const teslaView = await getEventView(rTesla.eventId);
  assert.ok(
    teslaView?.entities.every((e) => e.slug !== "musk"),
    "a Tesla-only event carries no person entity",
  );

  const cMusk = cluster([
    art({ source: "Reuters", title: "Elon Musk comments on X platform" }),
  ]);
  const rMusk = await persistCluster(cMusk, extractClaims(cMusk));
  const musk = await getEntityEvents("musk");
  assert.equal(musk.entity?.canonicalKey, "person:elon_musk");
  assert.equal(musk.entity?.type, "person");
  assert.equal(musk.label, "Elon Musk");
  assert.ok(
    musk.events.every((e) => e.id !== rTesla.eventId),
    "person event does not attach to the company's junction",
  );
});

test("co-occurrence never mints explicit relationships", async () => {
  setupDb();
  // fed + trump + us + china all in one event — classic co-mention
  const c = cluster([
    art({
      source: "Reuters",
      title: "Trump presses FED on rates as US-China talks resume",
    }),
  ]);
  await persistCluster(c, extractClaims(c));

  const rels = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_relationships`,
  );
  // V1.1 seeds 12 curated assertions; 0017 adds one portable
  // (google_llc subsidiary_of alphabet) — the superseding corrections
  // are PG-ONLY and stripped on pg-mem
  assert.equal(
    rels.rows[0].n,
    13,
    "junction co-mention adds no graph edges — count stays at the curated seed",
  );

  // getEntityEvents splits the two senses: fed's explicit edge is only
  // the seeded headquartered_in; us/china/trump arrive as co-occurrence
  const fed = await getEntityEvents("federal_reserve");
  assert.deepEqual(
    fed.relationships.map((r) => `${r.type}:${r.other.canonicalKey}`),
    ["headquartered_in:country:us"],
  );
  assert.deepEqual(
    fed.related.explicit.map((r) => r.canonicalKey),
    ["country:us"],
  );
  const coSlugs = fed.related.coOccurrence.map((r) => r.slug).sort();
  assert.ok(coSlugs.includes("trump"), "co-mention visible");
  assert.ok(coSlugs.includes("china"));
  assert.ok(
    !coSlugs.includes("us"),
    "explicitly-related entity does not double as a mere co-mention",
  );
});

test("relationship history: superseded assertions stay queryable", async () => {
  setupDb();
  const pool = getPool();
  const ids = await pool.query<{ id: string; canonical_key: string }>(
    `SELECT id, canonical_key FROM entities
     WHERE canonical_key IN ('central_bank:fed', 'country:us')`,
  );
  const fed = ids.rows.find((r) => r.canonical_key === "central_bank:fed")!;
  const us = ids.rows.find((r) => r.canonical_key === "country:us")!;

  const v1 = await pool.query<{ id: string }>(
    `INSERT INTO entity_relationships
       (from_entity_id, to_entity_id, relationship_type, source_method)
     VALUES ($1, $2, 'operates', 'curated') RETURNING id`,
    [fed.id, us.id],
  );
  // relation changes: the new assertion points at the old one — no
  // silent overwrite of the historical row
  const v2 = await pool.query<{ id: string }>(
    `INSERT INTO entity_relationships
       (from_entity_id, to_entity_id, relationship_type, source_method,
        supersedes_relationship_id)
     VALUES ($1, $2, 'part_of', 'curated', $3) RETURNING id`,
    [fed.id, us.id, v1.rows[0].id],
  );

  const view = await getEntityEvents("federal_reserve");
  const types = view.relationships.map((r) => r.type);
  assert.ok(types.includes("part_of"), "current assertion is visible");
  assert.ok(
    !types.includes("operates"),
    "superseded assertion leaves the view but not the table",
  );

  const history = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_relationships
     WHERE id = $1 OR supersedes_relationship_id = $1`,
    [v1.rows[0].id],
  );
  assert.equal(
    history.rows[0].n,
    2,
    "old assertion preserved alongside its successor",
  );
  assert.ok(v2.rows[0].id !== v1.rows[0].id);
});

test("evidence provenance: mentions and issuers point at versions", async () => {
  setupDb();
  // a primary document published under the entity's own name → issuer edge
  const fedDoc = art({
    source: "Federal Reserve",
    title: "Federal Reserve issues FOMC statement on rates",
    ingest: { sourceKind: "primary", discoveredVia: "official_api" },
  });
  const c1 = cluster([fedDoc]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  assert.ok(r1.created);

  const pool = getPool();
  const prov = await pool.query<{
    role: string;
    key: string;
    method: string;
  }>(
    `SELECT ee.mention_role AS role, en.canonical_key AS key, ee.method
     FROM evidence_entities ee
     JOIN entities en ON en.id = ee.entity_id
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN event_evidence x ON x.evidence_version_id = ev.id
     WHERE x.event_id = $1`,
    [r1.eventId],
  );
  assert.ok(
    prov.rows.some((r) => r.role === "issuer" && r.key === "central_bank:fed"),
    "a Fed-published primary doc asserts Fed as issuer",
  );
  assert.ok(
    prov.rows.some((r) => r.role === "subject" && r.key === "central_bank:fed"),
    "title mention recorded as subject with version provenance",
  );
  // every evidence-level relation resolves to a real version — the join
  // above is INNER, so unmatched rows could not even appear
  const orphans = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM evidence_entities ee
     LEFT JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     WHERE ev.id IS NULL`,
  );
  assert.equal(orphans.rows[0].n, 0);

  // SEC path: structuredData.cik resolves issuer by identifier, not by
  // string matching — the filing's entity is the legal company
  const secDoc = art({
    source: "Apple Inc.",
    title: "Apple Inc. Form 8-K filing",
    ingest: {
      sourceKind: "primary",
      discoveredVia: "official_api",
      structuredData: { cik: "0000320193", issuer: "Apple Inc." },
    },
  });
  const c2 = cluster([secDoc]);
  const r2 = await persistCluster(c2, extractClaims(c2));
  const appleIssuer = await pool.query<{ method: string }>(
    `SELECT DISTINCT ee.method FROM evidence_entities ee
     JOIN entities en ON en.id = ee.entity_id
     JOIN event_evidence x ON x.evidence_version_id = ee.evidence_version_id
     WHERE x.event_id = $1
       AND en.canonical_key = 'company:apple'
       AND ee.mention_role = 'issuer'`,
    [r2.eventId],
  );
  assert.deepEqual(
    appleIssuer.rows.map((r) => r.method),
    ["structured_cik"],
    "one issuer assertion per (version, entity, role) — the cik signal " +
      "wins as the most deterministic provenance method",
  );
});

test("brand vs company: Google resolves to the brand, Alphabet to the company", async () => {
  setupDb();
  const c = cluster([
    art({ source: "Reuters", title: "Google unveils new Gemini model" }),
  ]);
  await persistCluster(c, extractClaims(c));

  // surface "google" names the brand; the junction resolves to the
  // brand entity, never jumps to the issuer
  const google = await getEntityEvents("google");
  assert.equal(google.entity?.canonicalKey, "brand:google");
  assert.equal(google.entity?.type, "brand");

  // V1.2 legal graph: brand_of now points at Google LLC (the operating
  // entity), which is itself an Alphabet subsidiary. The superseding
  // assertion is PG-ONLY in the seed — simulate the applied correction
  // the same way production replays it: a new row superseding the V1.1
  // assertion, which then drops out of the live edge list.
  const pool = getPool();
  const oldEdge = await pool.query<{ id: string }>(
    `SELECT r.id FROM entity_relationships r
       JOIN entities f ON f.id = r.from_entity_id
       JOIN entities t ON t.id = r.to_entity_id
     WHERE f.canonical_key = 'brand:google'
       AND t.canonical_key = 'company:alphabet'
       AND r.relationship_type = 'brand_of'`,
  );
  assert.ok(oldEdge.rows[0], "V1.1 assertion exists to be superseded");
  const ids = await pool.query<{ id: string; key: string }>(
    `SELECT id, canonical_key key FROM entities
     WHERE canonical_key IN ('brand:google', 'company:google_llc')`,
  );
  const idOf = Object.fromEntries(ids.rows.map((r) => [r.key, r.id]));
  await pool.query(
    `INSERT INTO entity_relationships
       (from_entity_id, to_entity_id, relationship_type, supersedes_relationship_id)
     VALUES ($1, $2, 'brand_of', $3)`,
    [idOf["brand:google"], idOf["company:google_llc"], oldEdge.rows[0].id],
  );
  const corrected = await getEntityEvents("brand:google");
  assert.deepEqual(
    corrected.relationships.map((r) => `${r.type}:${r.other.canonicalKey}`),
    ["brand_of:company:google_llc"],
    "superseded edge drops out of the live relationship list",
  );

  // the legal surface names the company — a distinct identity joined
  // by the graph edge, not by shared aliases
  const alphabet = await getEntityEvents("alphabet");
  assert.equal(alphabet.entity?.canonicalKey, "company:alphabet");
  assert.equal(alphabet.entity?.type, "company");
  const googleEvents = await getEntityEvents("brand:google");
  assert.equal(googleEvents.entity?.type, "brand");
});

test("ambiguous aliases stay unresolved instead of guessing", async () => {
  setupDb();
  // 'tổng thống mỹ' is flagged ambiguous (role title, temporally bound)
  // — as a lookup string it resolves to trump only via slug, but a bare
  // normalized alias matching two entities must never pick one
  const pool = getPool();
  // plant a second entity sharing trump's alias to simulate ambiguity
  const other = await pool.query<{ id: string }>(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type)
     VALUES ('person:other_president', 'Other President', 'person')
     RETURNING id`,
  );
  await pool.query(
    `INSERT INTO entity_aliases (entity_id, alias, normalized_alias)
     VALUES ($1, 'donald trump', 'donald trump')`,
    [other.rows[0].id],
  );
  const resolved = await resolveEntityRef("Donald Trump");
  assert.equal(
    resolved,
    null,
    "two entities sharing an alias → explicit non-resolution, no guess",
  );
});

test("schema declares relationship append-only + canonical junction uniqueness", () => {
  // pg-mem cannot run triggers or prove partial-index rejection; the
  // schema must declare them so a real Postgres enforces both — the
  // UPDATE/DELETE rejection itself is verified on the live database
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const mig = readFileSync(`${dir}/0014_identity_hardening.sql`, "utf8");
  assert.match(mig, /CREATE TRIGGER entity_relationships_append_only/);
  assert.match(mig, /BEFORE UPDATE OR DELETE ON entity_relationships/);
  assert.match(mig, /reject_history_mutation\(\)/);
  assert.match(
    mig,
    /CREATE UNIQUE INDEX uq_event_entities_entity\s+ON event_entities \(event_id, entity_id\) WHERE entity_id IS NOT NULL/,
  );
});

test("canonical junction dedupe: two slugs, one entity, deterministic", () => {
  const E = "11111111-1111-1111-1111-111111111111";
  // alias in title + alias as mention → one row, title slug wins
  assert.deepEqual(
    dedupeEntityRows([
      { slug: "alphabet", id: E, title: false },
      { slug: "google", id: E, title: true },
    ]),
    [{ slug: "google", id: E, title: true }],
  );
  // neither in title → smallest slug kept, title flag OR'd
  assert.deepEqual(
    dedupeEntityRows([
      { slug: "zeta", id: E, title: false },
      { slug: "alpha", id: E, title: false },
    ]),
    [{ slug: "alpha", id: E, title: false }],
  );
  // distinct entities untouched
  const O = "22222222-2222-2222-2222-222222222222";
  assert.equal(
    dedupeEntityRows([
      { slug: "a", id: E, title: false },
      { slug: "b", id: O, title: false },
    ]).length,
    2,
  );
});

test("canonical route: entityHref prefers the durable type/name URL", () => {
  assert.equal(entityHref("company:alphabet"), "/entity/company/alphabet");
  assert.equal(entityHref("brand:google"), "/entity/brand/google");
  assert.equal(entityHref("central_bank:fed"), "/entity/central_bank/fed");
  // legacy compatibility — slug-only entities keep the old route
  assert.equal(entityHref(null, "federal_reserve"), "/entity/federal_reserve");
  assert.equal(entityHref(undefined, "nvidia"), "/entity/nvidia");
  assert.equal(entityHref(null, null), null);
});

test("canonical key and legacy slug resolve the same entity id", async () => {
  setupDb();
  const viaSlug = await getEntityEvents("alphabet");
  const viaKey = await getEntityEvents("company:alphabet");
  assert.ok(viaSlug.entity && viaKey.entity);
  assert.equal(viaSlug.entity.id, viaKey.entity.id);
  assert.equal(viaKey.entity.canonicalKey, "company:alphabet");
});

test("historical evidence backfill: shared rules, zero duplicates on rerun", async () => {
  setupDb();
  const c = cluster([
    art({
      source: "Reuters",
      title: "Federal Reserve cuts rates as Trump urges easing",
      summary: "The Fed moved after pressure; Vietnam exporters watch.",
    }),
  ]);
  await persistCluster(c, extractClaims(c));
  const pool = getPool();

  // a version minted WITHOUT evidence_entities rows — the historical
  // shape the backfill command processes
  const v = await pool.query<{ id: string }>(
    `INSERT INTO evidence_versions
       (document_id, version_no, title, summary, content_hash, observed_at)
     SELECT d.id, 99, 'NVIDIA earnings beat as Alphabet capex rises',
            'Tesla supply chain note', 'h-bfill', now()
     FROM evidence_documents d LIMIT 1
     RETURNING id`,
  );
  const vid = v.rows[0].id;
  const insert = async () => {
    const { rows } = await evidenceEntityAssertions(pool as never, {
      title: "NVIDIA earnings beat as Alphabet capex rises",
      summary: "Tesla supply chain note",
    });
    if (!rows.length) return 0;
    const res = await pool.query(
      `INSERT INTO evidence_entities
         (evidence_version_id, entity_id, mention_role, in_title, method)
       VALUES ${rows
         .map(
           (_, i) =>
             `($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`,
         )
         .join(",")}
       ON CONFLICT DO NOTHING`,
      [vid, ...rows.flatMap((r) => [r.id, r.role, r.title, r.method] as const)],
    );
    return res.rowCount ?? 0;
  };
  const first = await insert();
  const second = await insert();
  assert.ok(first > 0, "first pass inserts assertion rows");
  assert.equal(second, 0, "rerun inserts zero duplicates");
  const n = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM evidence_entities WHERE evidence_version_id = $1`,
    [vid],
  );
  assert.equal(n.rows[0].n, first);
});

/* ---------- Identity V1.2 — surface fidelity + legal graph ---------- */

test("surface fidelity: brand/company extraction never cross-maps", async () => {
  setupDb();
  await loadKeys();
  const pool = getPool();
  const keys = async (text: string) => {
    const { rows } = await evidenceEntityAssertions(pool as never, {
      title: text,
      summary: "",
    });
    return rows.map((r) => `${keyById.get(r.id) ?? "?"}:${r.role}`).sort();
  };

  // Alphabet-only → the legal entity; the brand must NOT appear
  const alpha = await keys("Alphabet reports earnings above expectations");
  assert.deepEqual(alpha, ["company:alphabet:subject"]);

  // Google-only → the brand, not the issuer
  const goog = await keys("Google launches Gemini 4");
  assert.deepEqual(goog, ["brand:google:subject"]);

  // both surfaces present → both identities, distinct roles by position
  const both = await keys("Google parent Alphabet reports earnings");
  assert.ok(both.includes("brand:google:subject"));
  assert.ok(both.includes("company:alphabet:subject"));

  // product-only → brand; parent company must NOT be inferred
  const gpt = await keys("ChatGPT gets a new voice mode");
  assert.deepEqual(gpt, ["brand:chatgpt:subject"]);

  const openai = await keys("OpenAI announces a partnership with Azure");
  assert.deepEqual(openai, ["company:openai:subject"]);

  // Green SM surface → the operator brand; VinFast must NOT be inferred
  const gsm = await keys("Xanh SM opens a new station network");
  assert.deepEqual(gsm, ["brand:green_sm:subject"]);

  // Google LLC is itself an extractable legal entity — and the string
  // still contains the "google" surface, so the brand surfaces too;
  // both assertions are surface-faithful
  const llc = await keys("Google LLC settles with the FTC");
  assert.ok(llc.includes("company:google_llc:subject"));
  assert.ok(llc.includes("brand:google:subject"));
});

test("SEC filing: Alphabet issuer stays the legal entity", async () => {
  setupDb();
  await loadKeys();
  const pool = getPool();
  const { rows } = await evidenceEntityAssertions(pool as never, {
    title: "Alphabet Inc. files annual report",
    summary: "",
    structuredData: { cik: "0001652044" },
    sourceName: "sec",
    sourceUrl: "https://sec.gov/edgar/10-K",
    isPrimary: true,
  });
  const issuer = rows.find((r) => r.method === "structured_cik");
  assert.ok(issuer, "structured CIK mints an issuer assertion");
  assert.equal(keyById.get(issuer!.id), "company:alphabet");
  assert.equal(issuer!.role, "issuer");
  // whatever the brand gazetteer says, it cannot change issuer identity
  assert.ok(
    !rows.some(
      (r) =>
        r.method === "structured_cik" && keyById.get(r.id) === "brand:google",
    ),
  );
});

test("matched_slug: every gazetteer assertion records its surface", async () => {
  setupDb();
  const c = cluster([
    art({
      source: "Reuters",
      title: "Google parent Alphabet reports earnings",
      summary: "ChatGPT rival pressures Gemini.",
    }),
  ]);
  await persistCluster(c, extractClaims(c));
  const pool = getPool();
  const { rows } = await pool.query<{
    slug: string;
    key: string;
    title: boolean;
  }>(
    `SELECT ee.matched_slug slug, e.canonical_key key, ee.in_title title
     FROM evidence_entities ee JOIN entities e ON e.id = ee.entity_id
     WHERE ee.method = 'gazetteer'
     ORDER BY key`,
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.slug]));
  assert.equal(map["brand:google"], "google");
  assert.equal(map["company:alphabet"], "alphabet");
  assert.equal(map["brand:chatgpt"], "chatgpt");
  // every gazetteer row carries a slug — no nulls on fresh writes
  assert.ok(rows.every((r) => r.slug !== null));
});

test("reconciliation: stale gazetteer rows rebuilt, structured untouched, idempotent", async () => {
  setupDb();
  const c = cluster([
    art({ source: "Reuters", title: "TikTok faces an EU fine" }),
  ]);
  await persistCluster(c, extractClaims(c));
  await loadKeys();
  const pool = getPool();

  const v = await pool.query<{ id: string }>(
    `INSERT INTO evidence_versions
       (document_id, version_no, title, summary, content_hash, observed_at)
     SELECT d.id, 50, 'TikTok faces an EU fine',
            'ByteDance-owned platform contests the ruling.',
            'h-v12', now()
     FROM evidence_documents d LIMIT 1 RETURNING id`,
  );
  const vid = v.rows[0].id;
  const ids = await pool.query<{ key: string; id: string }>(
    `SELECT canonical_key key, id FROM entities`,
  );
  const idOf = Object.fromEntries(ids.rows.map((r) => [r.key, r.id]));

  // V1-shape stale row: brand surface extracted as the company (wrong),
  // no matched_slug recorded. Plus a structured issuer row that must
  // survive any reconciliation untouched.
  await pool.query(
    `INSERT INTO evidence_entities
       (evidence_version_id, entity_id, mention_role, in_title, method)
     VALUES ($1, $2, 'subject', true, 'gazetteer'),
            ($1, $3, 'issuer', false, 'structured_cik')`,
    [vid, idOf["company:bytedance"], idOf["company:bytedance"]],
  );

  const runReconcile = async () => {
    const { rows: stored } = await pool.query(
      `SELECT ee.id, ee.entity_id, e.canonical_key, ee.mention_role,
              ee.in_title, ee.method, ee.matched_slug
       FROM evidence_entities ee JOIN entities e ON e.id = ee.entity_id
       WHERE ee.evidence_version_id = $1`,
      [vid],
    );
    const { rows: expected } = await evidenceEntityAssertions(pool as never, {
      title: "TikTok faces an EU fine",
      summary: "ByteDance-owned platform contests the ruling.",
    });
    const plan = planEvidenceReconciliation(stored as never, expected);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyEvidencePlan(client, vid, plan);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return plan;
  };

  const plan1 = await runReconcile();
  assert.equal(plan1.stale.length, 1, "stale company row identified");
  assert.equal(plan1.stale[0].canonical_key, "company:bytedance");
  assert.ok(
    plan1.missing.some(
      (r) => keyById.get(r.id) === "brand:tiktok" && r.role === "subject",
    ),
    "brand assertion identified as missing",
  );

  const after = await pool.query(
    `SELECT ee.method, e.canonical_key k, ee.mention_role role,
            ee.matched_slug slug
     FROM evidence_entities ee JOIN entities e ON e.id = ee.entity_id
     WHERE ee.evidence_version_id = $1 ORDER BY ee.method, k`,
    [vid],
  );
  const gaz = after.rows.filter((r) => r.method === "gazetteer");
  assert.ok(
    gaz.some((r) => r.k === "brand:tiktok" && r.slug === "tiktok"),
    "rebuilt assertion keeps surface → slug → entity trace",
  );
  assert.ok(
    !gaz.some((r) => r.k === "company:bytedance" && r.role === "subject"),
    "stale company subject removed",
  );
  assert.ok(
    after.rows.some(
      (r) => r.method === "structured_cik" && r.role === "issuer",
    ),
    "structured issuer row survives unchanged",
  );

  const plan2 = await runReconcile();
  assert.equal(plan2.stale.length, 0);
  assert.equal(plan2.missing.length, 0);
  assert.equal(plan2.refresh.length, 0);
});

test("V1.2 migrations: matched_slug + corrective superseding graph", () => {
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const m16 = readFileSync(`${dir}/0016_identity_v12.sql`, "utf8");
  assert.match(m16, /ADD COLUMN( IF NOT EXISTS)? matched_slug/);
  assert.match(
    m16,
    /DERIVED\s+PROJECTION/i,
    "projection-vs-history distinction documented",
  );
  const m17 = readFileSync(`${dir}/0017_entity_seed_v3.sql`, "utf8");
  for (const key of ["company:google_llc", "company:gsm"]) {
    assert.ok(m17.includes(key), `${key} seeded`);
  }
  assert.ok(m17.includes("subsidiary_of"), "subsidiary edge exists");
  assert.ok(m17.includes("operates"), "operator edge exists");
  assert.ok(m17.includes("supersedes_relationship_id"));
  assert.ok(m17.includes("SEC EDGAR"), "authoritative provenance seeded");
  // Phase 3: no fresh-install blind repoint — the V1.1 UPDATE that moved
  // every company:alphabet gazetteer row to brand:google must not recur
  assert.ok(
    !m17.match(/UPDATE evidence_entities SET entity_id/i),
    "no blanket entity_id repoint in the new seed",
  );
});

/* ---------- Data-API lockdown (0018) ---------- */

test("0018: Data-API lockdown declares RLS + revoke + fixed search paths", () => {
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const m = readFileSync(`${dir}/0018_data_api_lockdown.sql`, "utf8");

  // RLS deny-by-default on every current public table — count the
  // ALTER TABLE ... ENABLE ROW LEVEL SECURITY statements, not just one
  const rlsCount = (
    m.match(/ALTER TABLE \w+\s+ENABLE ROW LEVEL SECURITY/g) ?? []
  ).length;
  assert.ok(rlsCount >= 25, `25+ tables locked, found ${rlsCount}`);

  // grants revoked from the PostgREST roles, now and for future tables
  assert.match(m, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public/);
  assert.match(m, /FROM anon, authenticated/);
  assert.match(m, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres/);
  assert.match(m, /REVOKE ALL ON TABLES FROM anon, authenticated/);

  // auto-RLS event trigger so the invariant survives new tables
  assert.match(m, /CREATE EVENT TRIGGER tf_enable_rls_on_create/);
  assert.match(m, /pg_event_trigger_ddl_commands/);

  // functions pinned to explicit search paths — uuid_v7 needs
  // extensions.* (pgcrypto), the trigger needs pg_catalog only
  assert.match(
    m,
    /ALTER FUNCTION public\.uuid_v7\(\)\s+SET search_path = pg_catalog, extensions/,
  );
  assert.match(
    m,
    /ALTER FUNCTION public\.reject_history_mutation\(\)\s+SET search_path = pg_catalog/,
  );

  // and critically: no permissive policy was created just to silence
  // the advisor — deny-all is the intent
  assert.ok(
    !m.match(/CREATE POLICY/i),
    "no RLS policies — raw access is denied, not filtered",
  );

  // 0019: the SECURITY DEFINER event-trigger function is not RPC-callable
  const m19 = readFileSync(
    `${dir}/0019_revoke_event_trigger_execute.sql`,
    "utf8",
  );
  assert.match(
    m19,
    /REVOKE EXECUTE ON FUNCTION public\.tf_enable_rls_on_new_table\(\)\s+FROM PUBLIC, anon, authenticated/,
  );
});
