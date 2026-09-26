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
  assert.equal(
    rels.rows[0].n,
    12,
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
  assert.deepEqual(
    google.relationships.map((r) => `${r.type}:${r.other.canonicalKey}`),
    ["brand_of:company:alphabet"],
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
