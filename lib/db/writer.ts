/**
 * Writer layer — the only path that mutates the core schema.
 *
 * Pipeline per clustered story:
 *   ingestEvidence  → one EvidenceVersion per observed article state
 *   resolveEvent    → stable event identity via signature + 72h window
 *   attachEvidence  → event_evidence membership edges (never collapses)
 *   upsertClaim     → claim_version diff; identical values are a no-op
 *   emitChange      → changes row + new event_version, MATERIAL ONLY
 *
 * The load-bearing rule: "+1 outlet rewrote the same facts" attaches evidence
 * and bumps last_seen_at — it never creates a version or a change. That is
 * what separates a change engine from a timestamp diff.
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, toJsonb, canonValue } from "./pool";
import {
  computeClaimState,
  latestVotes,
  positionsFromVotes,
  posKey,
  rankWinner,
  type Position,
} from "./positions";
import { normalizeText } from "../model";
import { canonicalSourceName, mediaInfoFor } from "../mediaData";
import { entitySignature, extractEntities, canonicalEntity } from "../entities";
import {
  buildIncomingSide,
  clusterRepTextV2,
  decide,
  detectLanguage,
  eventRepText,
  repHash,
  RESOLVER_MAX_WINDOW_HOURS,
  eventSignature,
  type CandidateSide,
  type IncomingSide,
  type ResolverDecision,
} from "../resolver";
import { embedModel } from "../embed";
import {
  CLASSIFIER_VERSION,
  classifyLineage,
  DERIVED,
  resolveOrigins,
  type LineageAssertion,
  type LineageDoc,
} from "../lineage";
import type { Article, StoryCluster } from "../model";
import { enqueueDirty, enqueueDirtyClaim } from "./jobs";

/* ------------------------------- inputs ---------------------------------- */

export type IngestChannel =
  | "rss"
  | "news_sitemap"
  | "gdelt"
  | "official_rss"
  | "official_api"
  | "crawler"
  | "hn"
  | "api"
  | "manual";

export interface ExtractedClaim {
  /** subject|predicate|scope fingerprint — stable across value changes */
  claimKey: string;
  predicate: string;
  scopeKey?: string;
  claimType?:
    | "fact"
    | "numeric"
    | "quote"
    | "status"
    | "causal"
    | "forecast"
    | "interpretation";
  valueType?:
    "text" | "number" | "range" | "boolean" | "entity" | "date" | "json";
  value: unknown;
  unit?: string;
  state?:
    | "reported"
    | "supported"
    | "confirmed"
    | "disputed"
    | "corrected"
    | "retracted"
    | "unresolved";
  validFrom?: string;
  /** scope qualifiers (subject, region, meeting…) stored on claim_versions */
  qualifiers?: Record<string, unknown>;
  /** human-readable claim for the change summary */
  label: string;
  /** source name asserting it — resolved to evidence below */
  assertedBy: string;
  /** article that produced the claim — resolves to its evidence_version */
  articleId?: string;
  /** when the asserting doc was published — orders the source's votes */
  assertedAt?: string;
  /** extraction_method for claim_evidence — 'heuristic' regex, 'model' LLM */
  method?: "model" | "rule" | "manual";
  /**
   * News salience: "core" claims change the event's real-world state
   * (numbers, decisions, actions); "peripheral" claims are protocol /
   * ceremony / trivia facts the extractor could not rule out. Peripheral
   * claims stay in the canonical record but demote their change rows so
   * alerts and the rail never amplify "đeo găng tay khi đón Tập".
   */
  salience?: "core" | "peripheral";
}

export interface SourceMeta {
  kind?: "primary" | "publisher" | "community" | "aggregator";
  region?: "vietnam" | "global" | "unknown";
  language?: string;
  country?: string;
  /** publisher domain — identity, distinct from any discovery provider */
  domain?: string;
  /** per-source ingest channel override (e.g. 'hn' inside an rss batch) */
  channel?: IngestChannel;
}

/* ------------------------------- helpers --------------------------------- */

export function contentHash(title: string, body: string): string {
  return createHash("sha256")
    .update(normalizeText(title))
    .update("|")
    .update(normalizeText(body))
    .digest("hex")
    .slice(0, 32);
}

/** Strip tracking params so the same article dedupes across channels. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref_|mc_)/i.test(p)) u.searchParams.delete(p);
    }
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

const RESOLVE_WINDOW = "72 hours";

/* ----------------------------- step: source ------------------------------ */

/**
 * Upsert keyed on BOTH uniques the table owns: `name` and the partial
 * `uq_sources_domain`. ON CONFLICT can only target one index, so we
 * pre-resolve either key first — two display names sharing a domain
 * ("BBC News" vs "BBC News Tiếng Việt") must attach to the same source
 * row instead of crashing the cluster's transaction on 23505.
 */
async function upsertSource(
  client: PoolClient,
  name: string,
  meta: SourceMeta = {},
): Promise<string> {
  const domain = meta.domain ?? null;
  const { rows: existing } = await client.query<{
    id: string;
    name: string;
    domain: string | null;
  }>(
    `SELECT id, name, domain FROM sources
      WHERE name = $1 OR domain = $2`,
    [name, domain],
  );
  const nameRow = existing.find((r) => r.name === name);
  const domainRow = domain ? existing.find((r) => r.domain === domain) : null;
  if (nameRow || domainRow) {
    const owner = nameRow ?? domainRow!;
    // backfill only when no other row owns this domain — otherwise the
    // UPDATE would itself trip uq_sources_domain inside the transaction
    if (nameRow && !domainRow && nameRow.domain === null && domain)
      await client.query(`UPDATE sources SET domain = $2 WHERE id = $1`, [
        nameRow.id,
        domain,
      ]);
    return owner.id;
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sources (name, kind, region, language, country, domain)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE
       SET domain = COALESCE(sources.domain, EXCLUDED.domain),
           updated_at = sources.updated_at
     RETURNING id`,
    [
      name,
      meta.kind ?? "publisher",
      meta.region ?? "unknown",
      meta.language ?? null,
      meta.country ?? null,
      domain,
    ],
  );
  return rows[0].id;
}

/* ---------------------------- step: evidence ----------------------------- */

export interface EvidenceRef {
  documentId: string;
  evidenceVersionId: string;
  /** false when the content hash already existed (re-observation only) */
  newVersion: boolean;
}

/** document_type values the schema accepts — anything else maps to article. */
const DOCUMENT_TYPES = new Set([
  "article",
  "press_release",
  "transcript",
  "report",
  "blog",
  "social_post",
  "dataset",
  "legal_document",
  "filing",
  "other",
]);

async function ingestEvidence(
  client: PoolClient,
  article: Article,
  channel: IngestChannel,
  meta: SourceMeta = {},
): Promise<EvidenceRef> {
  const ingest = article.ingest;
  // publisher identity is canonical (org/domain), never the discovery layer
  const sourceName = canonicalSourceName(article.source, article.url);
  const docChannel: IngestChannel =
    ingest?.discoveredVia ?? meta?.channel ?? channel;
  const docType =
    ingest?.documentType && DOCUMENT_TYPES.has(ingest.documentType)
      ? ingest.documentType
      : "article";
  // sources.domain is publisher identity — only the registry's canonical
  // domain may mint it. An article's host is provenance, not identity
  // (test fixtures and multi-brand groups share hosts legitimately).
  const registryDomain = mediaInfoFor(sourceName, article.url)?.domains[0];
  const sourceId = await upsertSource(client, sourceName, {
    ...meta,
    domain: meta.domain ?? registryDomain,
    kind: meta.kind ?? ingest?.sourceKind,
    language: meta.language ?? article.language,
  });
  const url = canonicalUrl(article.url);
  const now = new Date().toISOString();

  const doc = await client.query<{
    id: string;
    current_version_id: string | null;
    metadata: Record<string, unknown>;
  }>(
    `INSERT INTO evidence_documents
       (source_id, canonical_url, external_id, document_type, published_at,
        first_seen_at, last_seen_at, discovered_via, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8::jsonb)
     ON CONFLICT (source_id, canonical_url)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING id, current_version_id, metadata`,
    [
      sourceId,
      url,
      ingest?.externalId ?? null,
      docType,
      article.publishedAt || null,
      now,
      docChannel,
      ingest?.structuredData ? toJsonb(ingest.structuredData) : "{}",
    ],
  );
  const documentId = doc.rows[0].id;
  // the version this new observation supersedes — links the version chain
  const supersedes = doc.rows[0].current_version_id;

  // metadata enrichment can arrive AFTER the editorial version (a detail
  // fetch that timed out last cycle succeeds now). Editorial versions are
  // immutable; the merged metadata lives on the document and every
  // effective merge is audit-logged.
  let mergedMeta: Record<string, unknown> | null = null;
  if (ingest?.structuredData) {
    const current = doc.rows[0].metadata ?? {};
    const delta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ingest.structuredData)) {
      if (v !== undefined && JSON.stringify(current[k]) !== JSON.stringify(v))
        delta[k] = v;
    }
    if (Object.keys(delta).length) {
      mergedMeta = { ...current, ...delta };
      await client.query(
        `UPDATE evidence_documents SET metadata = $2::jsonb WHERE id = $1`,
        [documentId, toJsonb(mergedMeta)],
      );
      await client.query(
        `INSERT INTO evidence_metadata_observations
           (document_id, delta, snapshot)
         VALUES ($1, $2::jsonb, $3::jsonb)`,
        [documentId, toJsonb(delta), toJsonb(mergedMeta)],
      );
    }
  }

  // discovery provenance — every channel that has ever surfaced this doc.
  // Same path re-seen → bump last_seen_at; never mints an EvidenceVersion.
  // Enrichment also pushes the merged metadata forward so a stale first
  // observation never wins over later detail.
  await client.query(
    `INSERT INTO evidence_discoveries
       (document_id, channel, provider, first_seen_at, last_seen_at,
        external_id, metadata)
     VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb)
     ON CONFLICT (document_id, channel, provider)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                   metadata = $7::jsonb`,
    [
      documentId,
      docChannel,
      ingest?.discoveryProvider ?? "",
      now,
      ingest?.externalId ?? null,
      ingest?.structuredData ? toJsonb(ingest.structuredData) : "{}",
      toJsonb(mergedMeta ?? ingest?.structuredData ?? {}),
    ],
  );

  const hash = contentHash(article.title, article.summary);
  const ver = await client.query<{ id: string }>(
    `INSERT INTO evidence_versions
       (document_id, version_no, title, summary, structured_data, content_hash,
        observed_at, source_updated_at, supersedes_version_id)
     SELECT $1,
            COALESCE(MAX(version_no), 0) + 1,
            $2, $3, $8::jsonb, $4, $5::timestamptz, $6::timestamptz, $7::uuid
     FROM evidence_versions WHERE document_id = $1
     ON CONFLICT (document_id, content_hash) DO NOTHING
     RETURNING id`,
    [
      documentId,
      // NUL bytes in scraped text kill Postgres text columns too
      article.title?.replace(/\u0000/g, " "),
      article.summary ? article.summary.replace(/\u0000/g, " ") : null,
      hash,
      now,
      // published_at and source_updated_at are different facts — only an
      // explicit upstream "updated/revised" timestamp belongs here
      ingest?.sourceUpdatedAt ?? null,
      supersedes,
      ingest?.structuredData ? toJsonb(ingest.structuredData) : null,
    ],
  );

  if (ver.rows[0]) {
    await client.query(
      `UPDATE evidence_documents
       SET current_version_id = $1, last_seen_at = $2
       WHERE id = $3`,
      [ver.rows[0].id, now, documentId],
    );
    // mention provenance rides with the immutable version — the same
    // content always asserts the same entity mentions
    await syncEvidenceEntities(client, ver.rows[0].id, article);
    return { documentId, evidenceVersionId: ver.rows[0].id, newVersion: true };
  }

  // content seen before — point at the existing version, no history created
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM evidence_versions
     WHERE document_id = $1 AND content_hash = $2`,
    [documentId, hash],
  );
  return {
    documentId,
    evidenceVersionId: existing.rows[0].id,
    newVersion: false,
  };
}

/* ----------------------------- step: event ------------------------------- */

// Load one document as a lineage candidate — used when a shared doc's
// stored parent lives outside this event's pool and the child's content
// just changed, so the old parent gets to defend its assertion instead of
// the child being blindly re-derived against an unrelated pool.
async function loadLineageDoc(
  client: PoolClient,
  documentId: string,
): Promise<LineageDoc | null> {
  const r = await client.query<{
    id: string;
    source: string;
    kind: string;
    title: string;
    summary: string | null;
    published_at: string | null;
    canonical_url: string;
    language: string | null;
  }>(
    `SELECT d.id, s.name AS source, s.kind::text AS kind,
            v.title, v.summary, d.published_at, d.canonical_url, s.language
     FROM evidence_documents d
     JOIN evidence_versions v ON v.id = d.current_version_id
     JOIN sources s ON s.id = d.source_id
     WHERE d.id = $1`,
    [documentId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    documentId: row.id,
    source: row.source,
    sourceKind: row.kind,
    title: row.title,
    summary: row.summary ?? "",
    publishedAt: row.published_at
      ? new Date(row.published_at).toISOString()
      : "",
    url: row.canonical_url,
    language: row.language ?? undefined,
  };
}

export interface EventRef {
  eventId: string;
  eventVersionId: string;
  created: boolean;
}

async function createEvent(
  client: PoolClient,
  args: {
    topic: string;
    eventType?: string;
    signature: string;
    entitySignature: string;
    entitySignatureCore?: string;
    title: string;
    summary: string;
    occurredAt?: string | null;
    importance?: number;
  },
): Promise<EventRef> {
  const now = new Date().toISOString();
  const ev = await client.query<{ id: string }>(
    `INSERT INTO events
       (event_type, topic, status, signature, entity_signature,
        entity_signature_core, first_seen_at, last_seen_at, occurred_at)
     VALUES ($1, $2, 'emerging', $3, $4, $5, $6, $6, $7)
     RETURNING id`,
    [
      args.eventType ?? "other",
      args.topic,
      args.signature,
      args.entitySignature,
      args.entitySignatureCore ?? args.entitySignature,
      now,
      args.occurredAt ?? null,
    ],
  );
  const eventId = ev.rows[0].id;

  const ver = await client.query<{ id: string }>(
    `INSERT INTO event_versions
       (event_id, version_no, title, summary, status,
        importance_score, effective_at, change_reason, content_hash)
     VALUES ($1, 1, $2, $3, 'emerging', $4, $5, 'event_created', $6)
     RETURNING id`,
    [
      eventId,
      args.title,
      args.summary,
      args.importance ?? null,
      now,
      contentHash(args.title, args.summary),
    ],
  );
  const eventVersionId = ver.rows[0].id;
  await client.query(
    `UPDATE events SET current_version_id = $1 WHERE id = $2`,
    [eventVersionId, eventId],
  );
  await client.query(
    `INSERT INTO changes
       (event_id, to_event_version_id, type, materiality, summary, detected_at)
     VALUES ($1, $2, 'event_created', 'medium', $3, $4)`,
    [eventId, eventVersionId, `Sự kiện mới: ${args.title}`, now],
  );
  // mirror the column's fallback — a caller that never distinguished
  // core from full signature declares every slug headline-tier, same
  // as the entity_signature_core value stored just above
  await syncEventEntities(
    client,
    eventId,
    args.entitySignature,
    args.entitySignatureCore ?? args.entitySignature,
  );
  return { eventId, eventVersionId, created: true };
}

/**
 * Junction projection of events.entity_signature — the ontology-graph
 * read path (entity pages, watch topics) queries rows, not exploded
 * text. Signature semantics are accumulate-only, so the sync is a
 * pure upsert: rows a slug joined when first observed stay forever.
 */
/**
 * slug → canonical entity id, per-client cached. Slugs outside the
 * gazetteer (legacy data, new patterns ahead of the seed) get a
 * documented 'unresolved' legacy entity instead of NULL — junction
 * rows always carry a canonical id.
 */
const ENTITY_ID_CACHE = new WeakMap<PoolClient, Map<string, string>>();

async function ensureEntity(client: PoolClient, slug: string): Promise<string> {
  let cache = ENTITY_ID_CACHE.get(client);
  if (!cache) {
    cache = new Map();
    ENTITY_ID_CACHE.set(client, cache);
  }
  const hit = cache.get(slug);
  if (hit !== undefined) return hit;

  const canon = canonicalEntity(slug);
  const key = canon?.key ?? `legacy:${slug}`;
  const found = await client.query<{ id: string }>(
    `SELECT id FROM entities WHERE canonical_key = $1`,
    [key],
  );
  let id = found.rows[0]?.id;
  if (!id) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO entities
         (canonical_key, canonical_name, entity_type, status, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
      canon
        ? [
            key,
            canon.name ?? slug,
            canon.type,
            "active",
            toJsonb({
              gazetteerSlug: slug,
              ambiguity: canon.ambiguity ?? null,
            }),
          ]
        : [
            key,
            slug,
            "other",
            "unresolved",
            toJsonb({ unresolved: true, legacySlug: slug }),
          ],
    );
    id =
      ins.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM entities WHERE canonical_key = $1`,
          [key],
        )
      ).rows[0].id;
  }
  cache.set(slug, id);
  return id;
}

/** Canonical uniqueness — two slugs can resolve to one entity (aliases
 *  across defs). One row per entity_id: keep the in-title slug, else the
 *  lexicographically smallest, and OR the title flags, so the stored
 *  compat slug is deterministic. */
export function dedupeEntityRows(
  input: { slug: string; id: string; title: boolean }[],
): { slug: string; id: string; title: boolean }[] {
  const byEntity = new Map<
    string,
    { slug: string; id: string; title: boolean }
  >();
  for (const r of input) {
    const cur = byEntity.get(r.id);
    if (!cur || (r.title === cur.title ? r.slug < cur.slug : r.title))
      byEntity.set(r.id, { ...r, title: cur?.title || r.title });
  }
  return [...byEntity.values()];
}

async function syncEventEntities(
  client: PoolClient,
  eventId: string,
  signature: string,
  coreSignature?: string,
): Promise<void> {
  const core = new Set((coreSignature ?? "").split(" ").filter(Boolean));
  const slugs = signature.split(" ").filter(Boolean);
  if (!slugs.length) return;
  // in_title rides the same accumulate-only rule as the slug itself —
  // a mention upgrades to headline when the slug joins the core
  // signature, and is never demoted back. entity_slug stays as the
  // transitional column; entity_id is the canonical read key.
  const ids = await Promise.all(slugs.map((s) => ensureEntity(client, s)));
  // canonical uniqueness: two slugs can resolve to one entity (aliases
  // across defs). One row per entity_id — keep the in-title slug, else
  // the lexicographically smallest, so the compat slug is deterministic.
  const rows = dedupeEntityRows(
    slugs.map((s, i) => ({ slug: s, id: ids[i], title: core.has(s) })),
  );
  await client.query(
    `INSERT INTO event_entities (event_id, entity_slug, entity_id, in_title)
     VALUES ${rows
       .map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`)
       .join(",")}
     ON CONFLICT DO NOTHING`,
    [eventId, ...rows.flatMap((r, i) => [r.slug, r.id, r.title] as const)],
  );
  const promoted = rows.filter((r) => r.title).map((r) => r.id);
  if (promoted.length) {
    // promote by entity_id — the stored slug may be a different alias of
    // the same canonical entity than the one now in the core signature
    await client.query(
      `UPDATE event_entities SET in_title = true
       WHERE event_id = $1 AND entity_id IN (${promoted
         .map((_, i) => `$${i + 2}`)
         .join(",")})`,
      [eventId, ...promoted],
    );
  }
}

/**
 * Evidence-level mention provenance — WHY an entity attaches to a
 * version. Deterministic V1: title hits are 'subject', body-only are
 * 'mentioned'; 'issuer' edges come only from explicit structured
 * signals (SEC cik, filing issuer name, cong-bao coQuan, or a primary
 * document published under the entity's own name).
 */
export interface EvidenceEntityInput {
  title: string | null;
  summary: string | null;
  /** ingest structuredData / evidence_versions.structured_data */
  structuredData?: Record<string, unknown> | null;
  /** publisher surface for the source_publisher issuer rule */
  sourceName?: string | null;
  sourceUrl?: string | null;
  /** source_publisher is gated to primary documents only */
  isPrimary?: boolean;
}

export interface EvidenceEntityRow {
  id: string;
  role: string;
  title: boolean;
  method: string;
  /** gazetteer slug whose surface matched — stored as matched_slug so a
   *  row is explainable (surface → slug → entity) without re-guessing
   *  from entity_id. Structured methods carry no slug. */
  slug?: string;
}

export interface EvidenceEntityResult {
  rows: EvidenceEntityRow[];
  /** structured issuer signals that named >1 entity or none — logged,
   *  never guessed (the ambiguous-alias invariant) */
  unresolvedIssuers: number;
}

/** The deterministic assertion set for one evidence version — shared by
 *  the live writer and scripts/backfill-evidence-entities.mts so both
 *  apply EXACTLY the same rules. No LLM anywhere on this path. */
export async function evidenceEntityAssertions(
  client: PoolClient,
  input: EvidenceEntityInput,
): Promise<EvidenceEntityResult> {
  const title = input.title ?? "";
  const summary = input.summary ?? "";
  const titleEnts = new Set(extractEntities(title));
  const allEnts = new Set([
    ...titleEnts,
    ...extractEntities(`${title} ${summary}`),
  ]);
  const rows: EvidenceEntityRow[] = [];
  for (const slug of allEnts) {
    rows.push({
      id: await ensureEntity(client, slug),
      role: titleEnts.has(slug) ? "subject" : "mentioned",
      title: titleEnts.has(slug),
      method: "gazetteer",
      slug,
    });
  }

  // issuer resolution — explicit structured signals only
  const sd = input.structuredData;
  const cik = typeof sd?.cik === "string" ? sd.cik : null;
  if (cik) {
    const r = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM entity_identifiers
       WHERE scheme = 'cik' AND value = $1`,
      [cik],
    );
    for (const row of r.rows)
      rows.push({
        id: row.entity_id,
        role: "issuer",
        title: false,
        method: "structured_cik",
      });
  }
  const coQuan = typeof sd?.coQuan === "string" ? sd.coQuan : null;
  let unresolvedIssuers = 0;
  const issuerName =
    (typeof sd?.issuer === "string" ? sd.issuer : null) ?? coQuan;
  if (issuerName) {
    const r = await client.query<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM entity_aliases
       WHERE normalized_alias = $1`,
      [normalizeText(issuerName)],
    );
    // an alias naming more than one entity is ambiguous — per the
    // invariant it stays unresolved instead of guessing an issuer
    if (r.rows.length === 1)
      rows.push({
        id: r.rows[0].entity_id,
        role: "issuer",
        title: false,
        method: coQuan ? "structured_coquan" : "structured_issuer",
      });
    else if (r.rows.length === 0) unresolvedIssuers++;
    else unresolvedIssuers += r.rows.length - 1;
  }
  // a PRIMARY document published under the entity's own name is issued
  // by that entity (FOMC statement by "Federal Reserve" → fed). Gated
  // to primary sourceKind so a same-named news source can never mint
  // issuer edges.
  if (input.isPrimary && input.sourceName) {
    const src = canonicalSourceName(
      input.sourceName,
      input.sourceUrl ?? undefined,
    );
    const r = await client.query<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM entity_aliases
       WHERE normalized_alias = $1`,
      [normalizeText(src)],
    );
    if (r.rows.length === 1)
      rows.push({
        id: r.rows[0].entity_id,
        role: "issuer",
        title: false,
        method: "source_publisher",
      });
    else unresolvedIssuers++;
  }

  // canonical uniqueness: aliases across defs resolve to one entity —
  // one row per (entity, role), in_title OR'd, structured method wins.
  const dedup = new Map<string, EvidenceEntityRow>();
  for (const r of rows) {
    const k = `${r.id} ${r.role}`;
    const cur = dedup.get(k);
    dedup.set(k, {
      id: r.id,
      role: r.role,
      title: (cur?.title ?? false) || r.title,
      method:
        !cur || (cur.method === "gazetteer" && r.method !== "gazetteer")
          ? r.method
          : cur.method,
      // matched_slug follows the surviving row; between gazetteer slugs
      // mapping to one entity the in-title slug wins, then smallest —
      // same determinism as the junction dedupe
      slug:
        !cur || r.method !== "gazetteer"
          ? r.slug
          : cur.method !== "gazetteer"
            ? cur.slug
            : r.title === cur.title
              ? (r.slug ?? "") < (cur.slug ?? "")
                ? r.slug
                : cur.slug
              : r.title
                ? r.slug
                : cur.slug,
    });
  }
  return { rows: [...dedup.values()], unresolvedIssuers };
}

async function syncEvidenceEntities(
  client: PoolClient,
  evidenceVersionId: string,
  article: Article,
): Promise<void> {
  const { rows: final } = await evidenceEntityAssertions(client, {
    title: article.title,
    summary: article.summary,
    structuredData: article.ingest?.structuredData as
      Record<string, unknown> | undefined,
    sourceName: article.source,
    sourceUrl: article.url,
    isPrimary: article.ingest?.sourceKind === "primary",
  });
  if (!final.length) return;
  await client.query(
    `INSERT INTO evidence_entities
       (evidence_version_id, entity_id, mention_role, in_title, method, matched_slug)
     VALUES ${final
       .map(
         (_, i) =>
           `($1, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6})`,
       )
       .join(",")}
     ON CONFLICT DO NOTHING`,
    [
      evidenceVersionId,
      ...final.flatMap(
        (r) => [r.id, r.role, r.title, r.method, r.slug ?? null] as const,
      ),
    ],
  );
}

/**
 * Match a cluster to a live event. Stage A: candidate retrieval — live
 * events inside the widest domain window plus their versioned claim
 * space. Stage B: the pure scorer (lib/resolver.ts) evaluates features
 * per candidate — the best merge decision wins; ambiguous counts as
 * split (precision-safe) but is flagged in telemetry.
 */
export interface ResolverEval {
  candidateId: string;
  decision: ResolverDecision;
}

type CandidateRow = {
  id: string;
  signature: string;
  entity_signature: string;
  entity_signature_core: string;
  current_version_id: string;
  occurred_at: string | null;
  topic: string;
  title: string;
  summary: string | null;
};

type CandidateSideEntry = {
  row: CandidateRow;
  cand: CandidateSide;
  rep: string;
  hash: string;
};

interface PreparedResolve {
  inc: ReturnType<typeof buildIncomingSide>;
  sides: CandidateSideEntry[];
  incRep: string;
}

/**
 * Stage A read phase — pure reads (candidate events + their claim space +
 * rep construction). Runs identically inside or outside a transaction, so
 * persistCluster can pre-run it before BEGIN to warm embeddings without
 * holding the lock.
 */
async function prepareResolve(
  client: PoolClient,
  cluster: StoryCluster,
  claims: ExtractedClaim[],
): Promise<PreparedResolve> {
  const inc = buildIncomingSide(cluster, claims);

  const cands = await client.query<CandidateRow>(
    `SELECT e.id, e.signature, e.entity_signature, e.entity_signature_core,
            e.current_version_id, e.occurred_at, e.topic,
            ev.title, ev.summary
     FROM events e
     LEFT JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged', 'archived')
       AND e.last_seen_at > now() - interval '${RESOLVER_MAX_WINDOW_HOURS} hours'`,
  );

  // claim space for ALL candidates in one round trip — per-candidate
  // queries made each persistCluster O(candidates) round trips, which is
  // what made a single persist transaction hold for minutes
  const claimRows = cands.rows.length
    ? await client.query<{
        event_id: string;
        claim_key: string;
        value: unknown;
      }>(
        `SELECT DISTINCT c.event_id, c.claim_key, cv.value
         FROM claims c
         JOIN claim_versions cv ON cv.claim_id = c.id
         WHERE c.event_id IN (${cands.rows.map((_, i) => `$${i + 1}`).join(",")})`,
        cands.rows.map((c) => c.id),
      )
    : { rows: [] as { event_id: string; claim_key: string; value: unknown }[] };
  const claimsByEvent = new Map<
    string,
    { claim_key: string; value: unknown }[]
  >();
  for (const r of claimRows.rows) {
    let arr = claimsByEvent.get(r.event_id);
    if (!arr) claimsByEvent.set(r.event_id, (arr = []));
    arr.push(r);
  }
  // stage A-side feature state per candidate (claim space + rep text)
  const sides: CandidateSideEntry[] = [];
  for (const c of cands.rows) {
    // candidate's claim space: every versioned value (all positions),
    // so a cluster asserting an earlier position still matches
    const ck = { rows: claimsByEvent.get(c.id) ?? [] };
    const claimLabels = ck.rows
      .map((r) => `${r.claim_key}=${JSON.stringify(canonValue(r.value))}`)
      .slice(0, 6);
    const rep = eventRepText({
      title: c.title ?? "",
      summary: c.summary ?? "",
      // recipe-identical to clusterRepTextV2 on a single-article
      // cluster — the event title is its own representative headline
      headlines: c.title ? [c.title] : [],
      entities: (c.entity_signature ?? "").split(" ").filter(Boolean),
      claimLabels,
    });
    sides.push({
      row: c,
      cand: {
        id: c.id,
        signature: c.signature ?? "",
        entitySignature: c.entity_signature ?? "",
        entitySignatureCore: c.entity_signature_core ?? "",
        claimKeys: new Set(ck.rows.map((r) => r.claim_key)),
        claimFps: new Set(
          ck.rows.map(
            (r) => `${r.claim_key}|${JSON.stringify(canonValue(r.value))}`,
          ),
        ),
        topic: c.topic,
        publishedAt: c.occurred_at ? Date.parse(c.occurred_at) : undefined,
        language: c.title ? detectLanguage(c.title) : undefined,
      },
      rep,
      hash: repHash(rep),
    });
  }

  const incRep = clusterRepTextV2(cluster, claims);
  return { inc, sides, incRep };
}

/**
 * Embedding resolution — tx-agnostic: candidate vectors come from the
 * persisted event_embeddings cache; only cache misses hit the network
 * embedder. When persistCluster pre-warms before BEGIN, the in-tx call
 * sees all candidates cached and (with incVec supplied) performs no
 * network call at all.
 */
async function ensureEmbeddings(
  client: PoolClient,
  prepared: PreparedResolve,
  embedder: (texts: string[]) => Promise<(number[] | null)[]>,
  incVec?: number[],
): Promise<number[] | undefined> {
  const { sides, incRep } = prepared;
  const cached = sides.length
    ? await client
        .query<{
          event_id: string;
          representation_hash: string;
          vector: number[];
        }>(
          `SELECT event_id, representation_hash, vector
           FROM event_embeddings
           WHERE (event_id, representation_hash) IN (
             ${sides.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",")})`,
          sides.flatMap((x) => [x.row.id, x.hash]),
        )
        .catch(() => ({ rows: [] as never[] }))
    : {
        rows: [] as {
          event_id: string;
          representation_hash: string;
          vector: number[];
        }[],
      };
  const cacheHit = new Map(
    cached.rows.map((r) => [
      `${r.event_id}|${r.representation_hash}`,
      r.vector,
    ]),
  );
  const missing = sides.filter((x) => !cacheHit.has(`${x.row.id}|${x.hash}`));
  const texts = [...(incVec ? [] : [incRep]), ...missing.map((x) => x.rep)];
  const vectors = texts.length ? await embedder(texts).catch(() => []) : [];
  const off = incVec ? 0 : 1;
  for (let i = 0; i < missing.length; i++) {
    const v = vectors[i + off];
    if (!v) continue;
    missing[i].cand.embedding = v;
    await client
      .query(
        `INSERT INTO event_embeddings
           (event_id, representation_hash, model, dims, vector, representation)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (event_id, representation_hash) DO NOTHING`,
        [
          missing[i].row.id,
          missing[i].hash,
          embedModel(),
          v.length,
          toJsonb(v),
          missing[i].rep,
        ],
      )
      .catch(() => {});
  }
  for (const x of sides) {
    const hit = cacheHit.get(`${x.row.id}|${x.hash}`);
    if (hit) x.cand.embedding = hit;
  }
  return incVec ?? vectors[0] ?? undefined;
}

async function resolveEvent(
  client: PoolClient,
  cluster: StoryCluster,
  claims: ExtractedClaim[],
  opts: {
    embedder?: (texts: string[]) => Promise<(number[] | null)[]>;
    /** incoming rep vector pre-computed outside the tx — skips the in-tx
     *  network call when set */
    incEmbedding?: number[];
  } = {},
): Promise<{ ref: EventRef; evals: ResolverEval[] }> {
  const prepared = await prepareResolve(client, cluster, claims);
  const { inc, sides } = prepared;
  const signature = inc.signature;
  const entSig = [...inc.entTokens].sort().join(" ");
  const entCoreSig = [...inc.entCoreTokens].sort().join(" ");

  const evals: ResolverEval[] = [];
  // stage A recall filter — semantic retrieval widens the pool but never
  // merges on its own: it only earns the pair a scored evaluation.
  if (opts.embedder) {
    inc.embedding = await ensureEmbeddings(
      client,
      prepared,
      opts.embedder,
      opts.incEmbedding,
    );
  }

  let best: CandidateRow | null = null;
  let bestScore = 0;
  for (const { row: c, cand } of sides) {
    const d = decide(inc, cand);
    evals.push({ candidateId: c.id, decision: d });
    if (process.env.DBG_RESOLVE)
      console.error(
        `resolve vs ${c.id.slice(0, 8)}: ${JSON.stringify(d)} ` +
          `inc=${JSON.stringify({ nums: [...inc.numTokens], core: [...inc.entCoreTokens], pub: inc.publishedAt })} ` +
          `cand=${JSON.stringify({ nums: cand.signature.split("|")[2], core: cand.entitySignatureCore, pub: cand.publishedAt })}`,
      );
    // candidate order is SQL-row order — unstable across runs. Two
    // candidates merging with the same score must not leave the attach
    // outcome to chance: lowest event id wins the tie deterministically.
    if (
      d.decision === "merge" &&
      (d.score > bestScore || (d.score === bestScore && best && c.id < best.id))
    ) {
      bestScore = d.score;
      best = c;
    }
  }

  if (best) {
    // entity signature accumulates — newly observed places join the event
    const merged = new Set([...inc.entTokens]);
    for (const e of best.entity_signature.split(" ").filter(Boolean)) {
      merged.add(e);
    }
    const mergedCore = new Set([...inc.entCoreTokens]);
    for (const e of (best.entity_signature_core || best.entity_signature)
      .split(" ")
      .filter(Boolean)) {
      mergedCore.add(e);
    }
    const mergedSig = [...merged].sort().join(" ");
    await client.query(
      `UPDATE events
       SET last_seen_at = now(), entity_signature = $2,
           entity_signature_core = $3
       WHERE id = $1`,
      [best.id, mergedSig, [...mergedCore].sort().join(" ")],
    );
    await syncEventEntities(
      client,
      best.id,
      mergedSig,
      [...mergedCore].sort().join(" "),
    );
    return {
      ref: {
        eventId: best.id,
        eventVersionId: best.current_version_id,
        created: false,
      },
      evals,
    };
  }
  return {
    ref: await createEvent(client, {
      topic: cluster.topic,
      signature,
      entitySignature: entSig,
      entitySignatureCore: entCoreSig,
      title: cluster.title,
      summary: cluster.summary,
      occurredAt: cluster.publishedAt,
      importance: cluster.significanceScore,
    }),
    evals,
  };
}

/* -------------------------- step: attach evidence ------------------------ */

async function attachEvidence(
  client: PoolClient,
  eventId: string,
  evidenceVersionId: string,
  args: {
    relationship?: string;
    method?: string;
    score?: number;
  } = {},
): Promise<boolean> {
  // existence check first — pg-mem misreports rowCount/RETURNING on
  // ON CONFLICT skips, and the SELECT is honest on real Postgres too.
  // A previously-detached edge resurrects: ignoring detached_at here
  // would leave the document invisible to readers forever.
  const exists = await client.query<{ detached_at: string | null }>(
    `SELECT detached_at FROM event_evidence
     WHERE event_id = $1 AND evidence_version_id = $2`,
    [eventId, evidenceVersionId],
  );
  if (exists.rows.length > 0) {
    if (exists.rows[0].detached_at == null) return false;
    await client.query(
      `UPDATE event_evidence SET detached_at = NULL
       WHERE event_id = $1 AND evidence_version_id = $2`,
      [eventId, evidenceVersionId],
    );
    return true;
  }
  await client.query(
    `INSERT INTO event_evidence
       (event_id, evidence_version_id, relationship, cluster_score, attached_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id, evidence_version_id) DO NOTHING`,
    [
      eventId,
      evidenceVersionId,
      args.relationship ?? "coverage",
      args.score ?? null,
      args.method ?? "semantic",
    ],
  );
  return true;
}

/* ------------------------------ step: claims ----------------------------- */

const CHANGE_MATERIALITY: Record<string, "low" | "medium" | "high"> = {
  new_claim: "high",
  claim_updated: "high",
  claim_confirmed: "medium",
  claim_disputed: "high",
  claim_corrected: "high",
  claim_retracted: "high",
  new_primary_source: "medium",
  new_independent_evidence: "medium",
  new_coverage: "low",
  event_resolved: "medium",
};

/* --------------------------- human claim display ------------------------- */
/* lives in lib/format.ts — pure, shared with client components (writer
 *  pulls `pg`, so it can't be imported into the browser bundle) */
export { fmtClaimValue, claimDisplayText, PRED_LABEL_VI } from "../format";
import { claimDisplayText, fmtClaimValue } from "../format";

interface ClaimOutcome {
  claimId: string;
  claimVersionId: string;
  /** claim_version superseded by this write — for change.from_claim_version_id */
  fromClaimVersionId?: string;
  /**
   * version the change record should point AT — the minted position
   * version, or the synthesized transition/winner version when the truth
   * converged without this document minting it. Differs from
   * claimVersionId (the evidence attach target) on consensus shifts.
   */
  changeVersionId?: string;
  /** null when the value+state matched the current version */
  change: { type: string; summary: string } | null;
}

async function newEventVersion(
  client: PoolClient,
  eventId: string,
  reason: string,
  opts: { status?: string } = {},
): Promise<string> {
  const cur = await client.query<{
    title: string;
    summary: string;
    status: string;
    importance_score: number | null;
    current_version_id: string;
  }>(
    `SELECT ev.title, ev.summary, ev.status, ev.importance_score,
            e.current_version_id
     FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.id = $1`,
    [eventId],
  );
  const c = cur.rows[0];
  const ver = await client.query<{ id: string }>(
    `INSERT INTO event_versions
       (event_id, version_no, title, summary, status, importance_score,
        effective_at, previous_version_id, change_reason, content_hash)
     SELECT $1::uuid, COALESCE(MAX(version_no), 0) + 1, $2, $3,
            $4::event_version_status, $5::double precision,
            now(), $6::uuid, $7::event_change_reason, $8
     FROM event_versions WHERE event_id = $1
     RETURNING id`,
    [
      eventId,
      c.title,
      c.summary,
      opts.status ?? c.status,
      c.importance_score,
      c.current_version_id,
      reason,
      contentHash(c.title + reason, c.summary),
    ],
  );
  const id = ver.rows[0].id;
  await client.query(
    `UPDATE events SET current_version_id = $1 WHERE id = $2`,
    [id, eventId],
  );
  return id;
}

interface PlannedChange {
  type: string;
  summary: string;
  claimId?: string;
  fromClaimVersionId?: string;
  toClaimVersionId?: string;
  /** event_version change_reason — required for material changes */
  reason?: string;
  /** false → annotates the snapshot without minting a version */
  material?: boolean;
  /** per-change override (peripheral-claim demotion); absent ⇒ type default */
  materiality?: "low" | "medium" | "high";
}

/* reason on the batched snapshot = the highest-priority material reason */
const REASON_PRIORITY = [
  "claim_updated",
  "claim_corrected",
  "claim_disputed",
  "primary_confirmation",
  "independent_origin",
  "new_material_claim",
  "event_resolved",
];

/**
 * One observation cycle → at most ONE material event snapshot.
 * All change rows in the cycle point at it; low-materiality rows
 * annotate it without having minted anything.
 */
async function flushChanges(
  client: PoolClient,
  eventId: string,
  pending: PlannedChange[],
  created: boolean,
): Promise<void> {
  if (pending.length === 0) return;
  const cur = await client.query<{ current_version_id: string }>(
    `SELECT current_version_id FROM events WHERE id = $1`,
    [eventId],
  );
  const fromVer = cur.rows[0].current_version_id;
  const hasMaterial = pending.some((p) => p.material !== false);
  // a just-created event needs no second snapshot — v1 already carries it
  const toVer =
    !created && hasMaterial
      ? await newEventVersion(
          client,
          eventId,
          pending
            .filter((p) => p.material !== false)
            .map((p) => p.reason ?? "manual")
            .sort(
              (a, b) => REASON_PRIORITY.indexOf(a) - REASON_PRIORITY.indexOf(b),
            )[0] ?? "manual",
        )
      : fromVer;

  for (const p of pending) {
    const material = p.material !== false;
    await client.query(
      `INSERT INTO changes
         (event_id, claim_id, from_event_version_id, to_event_version_id,
          from_claim_version_id, to_claim_version_id,
          type, materiality, summary, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        eventId,
        p.claimId ?? null,
        material && !created ? fromVer : null,
        toVer,
        p.fromClaimVersionId ?? null,
        p.toClaimVersionId ?? null,
        p.type,
        p.materiality ?? CHANGE_MATERIALITY[p.type] ?? "low",
        p.summary,
      ],
    );
  }
}

/** claim_change_type → the change record it produces (null = version only) */
const CHANGE_RECORD: Record<string, string> = {
  confirmed: "claim_confirmed",
  supported: "claim_supported",
  disputed: "claim_disputed",
  corrected: "claim_corrected",
  retracted: "claim_retracted",
  unresolved: "claim_updated",
  value_changed: "claim_updated",
};

const mapState = (s: string) =>
  s === "confirmed" ||
  s === "disputed" ||
  s === "corrected" ||
  s === "retracted"
    ? s
    : null;

/* Position identity + live-position machinery now lives in
 * ./positions.ts — shared verbatim with the batch adjudicator so ingest
 * and backfill compute the same claim truth. A unit change is still a
 * real change: "4 %" and "4 basis_points" are different facts. */

/**
 * Upsert one extracted claim against the event's truth-state.
 *
 * Versions are append-only ASSERTIONS; `current_version_id` is the
 * claim's standing truth and is recomputed deterministically from
 * positions, never from processing order:
 *   primary-backed position → the latest primary-asserted value wins
 *   otherwise               → most-corroborated; tie → earliest asserted
 *
 * State: winner asserted by a primary source → confirmed; ≥2 positions
 * each holding ≥1 supporter → disputed; else reported (a corrected or
 * retracted sole position keeps its terminal marker).
 */
async function upsertClaim(
  client: PoolClient,
  eventId: string,
  claim: ExtractedClaim,
  isPrimary = false,
  /**
   * canonical publisher identity for vote bookkeeping — persisted votes
   * key on sources.name; raw assertedBy aliases ("e.VnExpress") must
   * resolve to the same voter or self-revisions look like disputes
   */
  voteName?: string,
): Promise<ClaimOutcome> {
  const voter = voteName ?? claim.assertedBy;
  const now = new Date().toISOString();
  const valueJson = toJsonb(claim.value);
  // a claim originated by a primary source is born confirmed
  const state = claim.state ?? (isPrimary ? "confirmed" : "reported");

  const found = await client.query<{
    id: string;
    current_version_id: string;
    value: unknown;
    unit: string | null;
    state: string;
    version_no: number;
  }>(
    `SELECT c.id, c.current_version_id, cv.value, cv.unit, cv.state, cv.version_no
     FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
     WHERE c.event_id = $1 AND c.claim_key = $2`,
    [eventId, claim.claimKey],
  );

  if (!found.rows[0]) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO claims
         (event_id, claim_key, predicate, scope_key, claim_type,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id`,
      [
        eventId,
        claim.claimKey,
        claim.predicate,
        claim.scopeKey ?? null,
        claim.claimType ?? "fact",
        now,
      ],
    );
    const claimId = ins.rows[0].id;
    const cv = await client.query<{ id: string }>(
      `INSERT INTO claim_versions
         (claim_id, version_no, value_type, value, unit, qualifiers, state,
          valid_from, observed_at, change_type, content_hash)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'initial', $9)
       RETURNING id`,
      [
        claimId,
        claim.valueType ?? "text",
        valueJson,
        claim.unit ?? null,
        claim.qualifiers ? toJsonb(claim.qualifiers) : null,
        state,
        claim.validFrom ?? null,
        now,
        contentHash(claim.claimKey, valueJson),
      ],
    );
    const claimVersionId = cv.rows[0].id;
    await client.query(
      `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
      [claimVersionId, claimId],
    );
    return {
      claimId,
      claimVersionId,
      change: {
        type: "new_claim",
        summary: `Dữ kiện mới: ${claimDisplayText(claim)}`,
      },
    };
  }

  const cur = found.rows[0];
  await client.query(`UPDATE claims SET last_seen_at = $1 WHERE id = $2`, [
    now,
    cur.id,
  ]);

  /* ---- positions: all versioned values + latest vote per source ---- */
  const vers = await client.query<{
    id: string;
    version_no: number;
    value: unknown;
    value_type: string;
    unit: string | null;
    state: string;
    change_type: string;
  }>(
    `SELECT id, version_no, value, value_type, unit, state, change_type
     FROM claim_versions WHERE claim_id = $1 ORDER BY version_no`,
    [cur.id],
  );
  // a source's LATEST vote is its newest assertion BY EVIDENCE TIME —
  // the doc's published_at (falling back to our observation time), never
  // ingestion order. Ingestion order is an accident of the pipeline.
  const votes = await client.query<{
    name: string;
    value: unknown;
    unit: string | null;
    version_no: number;
    state: string;
    strength: string | null;
    vote_at: string;
  }>(
    `SELECT s.name, cv.value, cv.unit, cv.version_no, cv.state,
            ce.evidence_strength AS strength,
            COALESCE(d.published_at, ev.observed_at) AS vote_at
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE cv.claim_id = $1`,
    [cur.id],
  );

  const latestVote = latestVotes(
    votes.rows.map((v) => ({
      voter: v.name,
      pos: posKey(v.value, v.unit),
      valueJson: toJsonb(v.value),
      unit: v.unit,
      versionNo: v.version_no,
      state: v.state,
      primary: v.strength === "direct",
      at: Date.parse(v.vote_at),
    })),
  );

  let maxVersionNo = 0;
  for (const ver of vers.rows)
    maxVersionNo = Math.max(maxVersionNo, ver.version_no);
  const positions = positionsFromVotes(
    latestVote,
    vers.rows.map((ver) => ({
      id: ver.id,
      version_no: ver.version_no,
      pos: posKey(ver.value, ver.unit),
      valueJson: toJsonb(ver.value),
    })),
  );

  const priorVote = latestVote.get(voter);
  const priorVoteJson = priorVote?.valueJson ?? null;
  const priorPos = priorVote?.pos ?? null;
  const claimPos = posKey(claim.value, claim.unit);
  const explicit = claim.state ? mapState(claim.state) : null;
  const upgradeable = cur.state === "reported" || cur.state === "supported";

  // an assertion OLDER than the source's latest vote is history arriving
  // late — evidence attaches to the position it supports, but it mints
  // nothing and never moves the source's live position
  const assertedAtMs = claim.assertedAt ? Date.parse(claim.assertedAt) : NaN;
  const stale =
    priorVote !== undefined &&
    !Number.isNaN(assertedAtMs) &&
    assertedAtMs < priorVote.at;

  /* ---- decide whether this assertion mints a version ---- */
  let mint: { state: string; changeType: string } | null = null;
  if (stale) {
    // a stale value never seen before still earns a version — the
    // position existed in history — but it emits no change record:
    // a late-arriving old article is not a live dispute
    if (!positions.has(claimPos))
      mint = { state: "disputed", changeType: "disputed" };
  } else if (priorPos === claimPos) {
    // same-position re-assert — corroboration mints nothing
    if (explicit) mint = { state: claim.state!, changeType: explicit };
    else if (isPrimary && upgradeable)
      mint = { state: "confirmed", changeType: "confirmed" };
  } else if (priorPos !== null) {
    // the source moved its own vote — self-revision
    mint = explicit
      ? { state: claim.state!, changeType: explicit }
      : { state: "corrected", changeType: "corrected" };
  } else if (positions.has(claimPos)) {
    // a new source corroborates an existing position
    if (explicit) mint = { state: claim.state!, changeType: explicit };
    else if (isPrimary && upgradeable)
      mint = { state: "confirmed", changeType: "confirmed" };
  } else {
    // a brand-new position — authority revises, an outlet disputes
    if (explicit) mint = { state: claim.state!, changeType: explicit };
    else if (isPrimary)
      mint = { state: "confirmed", changeType: "value_changed" };
    else mint = { state: "disputed", changeType: "disputed" };
  }

  // replay guard is PER-VOTER: re-asserting the same position+state this
  // source already stands on is a semantic no-op; a DIFFERENT source
  // asserting the same terminal state (retract/dispute/correct) is a real
  // act and must mint. 'confirmed' also dedupes across voters — an
  // already-confirmed position gains nothing from a second confirmation.
  // A self-revision (priorPos !== claimPos) is always a real move.
  if (mint && (priorPos === claimPos || priorPos === null)) {
    const standingId = positions.get(claimPos)?.versionId;
    const standing = standingId
      ? vers.rows.find((v) => v.id === standingId)
      : undefined;
    const replay =
      (priorPos === claimPos && priorVote?.state === mint.state) ||
      (mint.state === "confirmed" && standing?.state === "confirmed");
    if (replay) mint = null;
  }

  let mintedId: string | null = null;
  let emitted: { type: string; summary: string } | null = null;
  if (mint) {
    const newVn = maxVersionNo + 1;
    const cv = await client.query<{ id: string }>(
      `INSERT INTO claim_versions
         (claim_id, version_no, value_type, value, unit, qualifiers, state,
          valid_from, observed_at, previous_version_id, change_type,
          content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        cur.id,
        newVn,
        claim.valueType ?? "text",
        valueJson,
        claim.unit ?? null,
        claim.qualifiers ? toJsonb(claim.qualifiers) : null,
        mint.state,
        claim.validFrom ?? null,
        now,
        cur.current_version_id,
        mint.changeType,
        contentHash(claim.claimKey, `${valueJson}${mint.state}${newVn}`),
      ],
    );
    mintedId = cv.rows[0].id;
    maxVersionNo = newVn;

    const head = claimDisplayText({ ...claim, value: "", valueType: "text" });
    const summary =
      priorPos !== claimPos && priorVoteJson !== null
        ? `${head}: ${fmtClaimValue(JSON.parse(priorVoteJson), priorVote?.unit ?? claim.unit)} → ${fmtClaimValue(claim.value, claim.unit)}`
        : priorPos !== claimPos && !positions.has(claimPos)
          ? `${head}: ${fmtClaimValue(cur.value, cur.unit ?? claim.unit)} → ${fmtClaimValue(claim.value, claim.unit)}`
          : `${head} — ${cur.state} → ${mint.state}`;
    if (!stale) {
      emitted = {
        type: CHANGE_RECORD[mint.changeType] ?? "claim_updated",
        summary,
      };
    }

    const p =
      positions.get(claimPos) ??
      ({
        pos: claimPos,
        valueJson,
        versionId: mintedId,
        versionNo: 0,
        origins: new Set(),
        hasPrimary: false,
        latestAt: 0,
        latestPrimaryAt: 0,
      } satisfies Position);
    p.versionId = mintedId;
    p.versionNo = newVn;
    positions.set(claimPos, p);
  }

  // register this document's vote — a moved vote LEAVES its old position
  // (a self-correction withdraws support for the earlier figure).
  // A stale assertion moves nothing: the source stays at its newest vote.
  if (!stale && priorPos !== null && priorPos !== claimPos) {
    positions.get(priorPos)?.origins.delete(voter);
  }
  const votePos = positions.get(claimPos);
  if (votePos && !stale) {
    const assertedAtMs = claim.assertedAt
      ? Date.parse(claim.assertedAt)
      : Date.parse(now);
    votePos.origins.add(voter);
    if (isPrimary) {
      votePos.hasPrimary = true;
      votePos.latestPrimaryAt = Math.max(votePos.latestPrimaryAt, assertedAtMs);
    }
    votePos.latestAt = Math.max(votePos.latestAt, assertedAtMs);
  }

  /* ---- deterministic winner: never order-dependent ---- */
  const winner = rankWinner([...positions.values()]);
  // a claim always has ≥1 version → ≥1 position; defensive no-op
  if (!winner)
    return {
      claimId: cur.id,
      claimVersionId: cur.current_version_id,
      change: null,
    };

  // vers was fetched before this call's mint — a winner minted this round
  // isn't in the snapshot, so synthesize its row from what we just wrote
  const winnerVer =
    winner.versionId === mintedId
      ? {
          id: mintedId,
          version_no: maxVersionNo,
          value: claim.value,
          value_type: claim.valueType ?? "text",
          unit: claim.unit ?? null,
          state: mint!.state,
          change_type: mint!.changeType,
        }
      : vers.rows.find((v) => v.id === winner.versionId);
  const computedState = computeClaimState({
    positions: [...positions.values()],
    winnerVersionState: winnerVer?.state,
  });

  /* ---- converge current_version_id to the winner ---- */
  let currentVersionId = winner.versionId;
  if (winnerVer && winnerVer.state !== computedState) {
    // upgrade-only state mints: reported→confirmed, →disputed.
    // 'supported' is deliberately NOT minted here: ingest votes by
    // source name, and a wire reprint under a different outlet would
    // inflate origin count — corroboration-tier escalation is owned by
    // the batch adjudicator which votes by LINEAGE ROOT.
    // never mint silent downgrades (disputed→reported) — resolution is
    // recorded by whichever version actually settles the dispute.
    // The version always mints (it IS the truth state); the change row
    // only emits when this round didn't already describe the transition.
    const upgrade =
      computedState === "confirmed" || computedState === "disputed";
    if (upgrade) {
      const newVn = maxVersionNo + 1;
      const cv = await client.query<{ id: string }>(
        `INSERT INTO claim_versions
           (claim_id, version_no, value_type, value, unit, qualifiers,
            state, valid_from, observed_at, previous_version_id,
            change_type, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          cur.id,
          newVn,
          winnerVer?.value_type ?? claim.valueType ?? "text",
          // already valid JSON text — JSON.parse then pg-serialize breaks
          // string scalars ('"approved"' → bare 'approved' → invalid jsonb)
          winner.valueJson,
          winnerVer?.unit ?? claim.unit ?? null,
          null,
          computedState,
          claim.validFrom ?? null,
          now,
          cur.current_version_id,
          computedState,
          contentHash(claim.claimKey, `${winner.valueJson}${newVn}`),
        ],
      );
      currentVersionId = cv.rows[0].id;
      if (!emitted) {
        emitted = {
          type: CHANGE_RECORD[computedState] ?? "claim_updated",
          summary: `${claim.label} — ${winnerVer.state} → ${computedState}`,
        };
      }
    }
  }

  // corroboration moved the standing truth to an existing position — the
  // transition itself is a real event and needs its own version: reusing
  // the old position version exposes ITS stale chain (prev_value from
  // prehistory, observed_at = position birth, not when truth moved)
  if (
    !mintedId &&
    !emitted &&
    posKey(JSON.parse(winner.valueJson), winnerVer?.unit) !==
      posKey(cur.value, cur.unit)
  ) {
    const newVn = maxVersionNo + 1;
    const cv = await client.query<{ id: string }>(
      `INSERT INTO claim_versions
         (claim_id, version_no, value_type, value, unit, qualifiers, state,
          valid_from, observed_at, previous_version_id, change_type,
          content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'value_changed', $11)
       RETURNING id`,
      [
        cur.id,
        newVn,
        winnerVer?.value_type ?? claim.valueType ?? "text",
        winner.valueJson,
        winnerVer?.unit ?? claim.unit ?? null,
        claim.qualifiers ? toJsonb(claim.qualifiers) : null,
        computedState,
        claim.validFrom ?? null,
        now,
        cur.current_version_id,
        contentHash(claim.claimKey, `${winner.valueJson}${newVn}`),
      ],
    );
    currentVersionId = cv.rows[0].id;
    emitted = {
      type: "claim_updated",
      summary: `Đồng thuận dịch chuyển — ${claimDisplayText({ ...claim, value: "", valueType: "text" })}: ${fmtClaimValue(cur.value, claim.unit)} → ${fmtClaimValue(JSON.parse(winner.valueJson), claim.unit)}`,
    };
  }

  await client.query(
    `UPDATE claims SET current_version_id = $1, last_seen_at = $2 WHERE id = $3`,
    [currentVersionId, now, cur.id],
  );

  return {
    claimId: cur.id,
    // the version this document's evidence attaches to — the position it
    // asserts, minted now or the standing version of that position
    claimVersionId: mintedId ?? votePos?.versionId ?? currentVersionId,
    changeVersionId: emitted ? (mintedId ?? currentVersionId) : undefined,
    fromClaimVersionId: cur.current_version_id,
    change: emitted,
  };
}

async function linkClaimEvidence(
  client: PoolClient,
  claimVersionId: string,
  evidenceVersionId: string,
  stance = "supports",
  evidenceStrength = "secondary",
  method: "model" | "rule" | "manual" = "rule",
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO claim_evidence
       (claim_version_id, evidence_version_id, stance, evidence_strength,
        extraction_method)
     VALUES ($1, $2, $3, $4::evidence_strength, $5::extraction_method)
     ON CONFLICT (claim_version_id, evidence_version_id) DO NOTHING`,
    [claimVersionId, evidenceVersionId, stance, evidenceStrength, method],
  );
  return (rowCount ?? 0) > 0;
}

/* ---------------------------- orchestration ------------------------------ */

export interface PersistResult {
  eventId: string;
  created: boolean;
  evidenceAttached: number;
  changes: string[];
  /** per-article ingest outcomes for coverage telemetry */
  ingested: {
    source: string;
    primary: boolean;
    newVersion: boolean;
    /** lineage relation of this article's document ('original' = own root) */
    relation?: string;
    /** the ingested article's id (telemetry join key) */
    articleId?: string;
  }[];
  /** lineage outcomes for documents attached this call */
  lineage: { original: number; derived: number; unknown: number };
  /** count of material changes minted this call (EventVersion-worthy) */
  materialChanges: number;
  /** primary-source documents attached this call */
  primaryAttached: number;
  /** stage-B evaluations produced while resolving this cluster */
  resolverEvals?: ResolverEval[];
}

/**
 * Persist one cluster end-to-end in a single transaction.
 * claims are keyed to the evidence of their asserting source where possible;
 * unresolvable assertions link to the lead evidence.
 */
export async function persistCluster(
  cluster: StoryCluster,
  claims: ExtractedClaim[],
  opts: {
    channel?: IngestChannel;
    sourceMeta?: Record<string, SourceMeta>;
    eventType?: string;
    /** optional semantic scorer — absent ⇒ deterministic lexical path */
    embedder?: (texts: string[]) => Promise<(number[] | null)[]>;
  } = {},
): Promise<PersistResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // 0) warm resolve embeddings OUTSIDE the tx — embedder is a network
    //    call; inside the edition-wide advisory lock it serializes every
    //    concurrent build on Gemini latency. Pre-run the identical read
    //    phase in autocommit, embed the misses, then the in-tx resolve
    //    sees only cache hits.
    let incEmbedding: number[] | undefined;
    if (opts.embedder) {
      const prepared = await prepareResolve(client, cluster, claims);
      incEmbedding = await ensureEmbeddings(
        client,
        prepared,
        opts.embedder,
      ).catch(() => undefined);
    }

    await client.query("BEGIN");
    // Supabase disk-quota guard can leave default_transaction_read_only=on
    // (Sept-27 incident: resolver_decisions bloat → silent pipeline death).
    // Force RW while it lingers; pg-mem can't parse SET TRANSACTION —
    // that's fine, tests aren't in a read-only tx anyway.
    await client.query("SET TRANSACTION READ WRITE").catch(() => {});

    // 1) every member article becomes an observed evidence version.
    // keyed by article (not source) — one source can carry several
    // documents in a cluster and claims must resolve to the right doc
    const evByArticle = new Map<string, string>();
    const docByArticle = new Map<string, string>();
    const evBySource = new Map<string, string>();
    const primarySources = new Set<string>();
    const ingested: PersistResult["ingested"] = [];
    let leadEvidenceId = "";
    for (const article of cluster.articles) {
      const meta = opts.sourceMeta?.[article.source];
      const ev = await ingestEvidence(
        client,
        article,
        opts.channel ?? "rss",
        meta,
      );
      evByArticle.set(article.id, ev.evidenceVersionId);
      docByArticle.set(article.id, ev.documentId);
      evBySource.set(article.source, ev.evidenceVersionId);
      const primary =
        meta?.kind === "primary" || article.ingest?.sourceKind === "primary";
      if (primary)
        primarySources.add(canonicalSourceName(article.source, article.url));
      ingested.push({
        source: article.source,
        primary,
        newVersion: ev.newVersion,
        articleId: article.id,
      });
      if (article.id === cluster.leadArticle.id) {
        leadEvidenceId = ev.evidenceVersionId;
      }
    }

    // 2) event identity — claims join the merge decision (value-aware)
    const { ref: evRef, evals: resolverEvals } = await resolveEvent(
      client,
      cluster,
      claims,
      { embedder: opts.embedder, incEmbedding },
    );
    const { eventId, created } = evRef;

    // 2b) resolver telemetry — auditable pair-level decisions.
    // Volume control: routine `split` evals are dropped (99.5% of rows,
    // ~650k/day blew the Supabase disk quota and forced the DB read-only).
    // A split's score is max(sigSim, entitySim, claimOverlap, semantic) —
    // routine same-country entity overlap lands ≥0.5 without real merge
    // signal, and `entity_blocked` splits are deliberate refusals. Kept:
    // merges, ambiguous calls, splits ≥0.9 (contradictory near-merges),
    // splits ≥0.7 not entity-blocked. Features stripped on splits — the
    // heavy jsonb — merges/ambiguous keep the full audit trail.
    if (resolverEvals.length) {
      const json = toJsonb;
      await client
        .query(
          `INSERT INTO resolver_decisions
             (incoming_cluster, candidate_event_id, chosen_event_id,
              decision, path, score, reasons, hard_blocks, features,
              semantic_available)
           SELECT $1, t.cand, $2, t.decision, t.path, t.score,
                  t.reasons::jsonb, t.blocks::jsonb,
                  CASE WHEN t.decision = 'split' THEN '{}'::jsonb
                       ELSE t.features::jsonb END,
                  t.sem
           FROM unnest(
             $3::uuid[], $4::text[], $5::text[], $6::double precision[],
             $7::text[], $8::text[], $9::text[], $10::boolean[]
           ) AS t(cand, decision, path, score, reasons, blocks, features, sem)
           WHERE t.decision <> 'split'
              OR t.score >= 0.9
              OR (t.score >= 0.7 AND t.path <> 'entity_blocked')`,
          [
            cluster.id,
            eventId,
            resolverEvals.map((e) => e.candidateId),
            resolverEvals.map((e) => e.decision.decision),
            resolverEvals.map((e) => e.decision.path),
            resolverEvals.map((e) => e.decision.score ?? null),
            resolverEvals.map((e) => json(e.decision.reasons)),
            resolverEvals.map((e) => json(e.decision.hardBlocks)),
            resolverEvals.map((e) => json(e.decision.features ?? {})),
            resolverEvals.map(
              (e) => e.decision.features?.semanticSimilarity !== undefined,
            ),
          ],
        )
        .catch(() => {}); // telemetry must never break persistence
    }

    // 3) membership edges — one event_evidence row per DOCUMENT
    const newEvidence: {
      evId: string;
      articleId: string;
      source: string;
      primary: boolean;
    }[] = [];
    let attached = 0;
    for (const article of cluster.articles) {
      const evId = evByArticle.get(article.id);
      if (!evId) continue;
      const isOrigin = evId === leadEvidenceId && created;
      const primary = primarySources.has(
        canonicalSourceName(article.source, article.url),
      );
      const relationship = isOrigin
        ? "origin"
        : primary
          ? "primary_evidence"
          : "coverage";
      if (
        await attachEvidence(client, eventId, evId, {
          relationship,
          method: "semantic",
        })
      ) {
        attached++;
        if (!isOrigin)
          newEvidence.push({
            evId,
            articleId: article.id,
            source: article.source,
            primary,
          });
      }
    }

    // 3.5) information lineage — every document on the event is
    // (re-)evaluated against the full candidate pool each cycle. New
    // evidence can flip an assertion (a late wire parent arriving
    // re-points earlier unknowns); material changes append a new
    // version — history is never rewritten.
    const relByArticle = new Map<string, string>();
    const sourceByArticle = new Map<string, string>();
    let priorSources = new Set<string>();
    const lineageStats = { original: 0, derived: 0, unknown: 0 };
    // docs whose assertion changed to a confirmed origin this cycle —
    // late-established independence still counts once
    const confirmedUpgrades: { docId: string; source: string }[] = [];
    {
      const attachedArticles = cluster.articles.filter((a) =>
        docByArticle.has(a.id),
      );
      // candidate pool = all live documents of this event (incl. this batch)
      const candR = await client.query<{
        id: string;
        source: string;
        kind: string;
        title: string;
        summary: string | null;
        published_at: string | null;
        canonical_url: string;
        language: string | null;
      }>(
        `SELECT DISTINCT d.id, s.name AS source, s.kind::text AS kind,
                v.title, v.summary, d.published_at, d.canonical_url,
                s.language
         FROM event_evidence ee
         JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
         JOIN evidence_documents d ON d.id = ev.document_id
         JOIN evidence_versions v ON v.id = d.current_version_id
         JOIN sources s ON s.id = d.source_id
         WHERE ee.event_id = $1 AND ee.detached_at IS NULL`,
        [eventId],
      );
      const candidates: LineageDoc[] = candR.rows.map((r) => ({
        documentId: r.id,
        source: r.source,
        sourceKind: r.kind,
        title: r.title,
        summary: r.summary ?? "",
        publishedAt: r.published_at
          ? new Date(r.published_at).toISOString()
          : "",
        url: r.canonical_url,
        language: r.language ?? undefined,
      }));
      const candById = new Map(candidates.map((c) => [c.documentId, c]));
      // sources already on the event BEFORE this batch — a new document
      // from one of them can never be a new independent origin, it's a
      // same-organization re-report at best
      const batchDocIds = new Set(
        attachedArticles.map((a) => docByArticle.get(a.id)!),
      );
      priorSources = new Set(
        candidates
          .filter((c) => !batchDocIds.has(c.documentId))
          .map((c) => c.source),
      );
      const candIds = candidates.map((c) => c.documentId);
      // latest lineage assertion per document — the previous version a
      // reclassification supersedes (append-only audit chain)
      const existing = new Map<
        string,
        {
          id: string;
          parent: string | null;
          relation: string;
          version_no: number;
        }
      >();
      if (candIds.length) {
        const lr = await client.query<{
          id: string;
          child_document_id: string;
          parent_document_id: string | null;
          relation: string;
          version_no: number;
        }>(
          `SELECT DISTINCT ON (child_document_id)
                  id, child_document_id, parent_document_id, relation::text,
                  version_no
           FROM evidence_lineage
           WHERE child_document_id IN (${candIds.map((_, i) => `$${i + 1}`).join(",")})
           ORDER BY child_document_id, version_no DESC`,
          candIds,
        );
        for (const r of lr.rows)
          existing.set(r.child_document_id, {
            id: r.id,
            parent: r.parent_document_id,
            relation: r.relation,
            version_no: r.version_no,
          });
      }
      // assertions used for origin walks — latest per doc
      const assertionMap = new Map<string, LineageAssertion>();
      for (const [id, e] of existing)
        assertionMap.set(id, {
          parentDocumentId: e.parent,
          relation: e.relation as LineageAssertion["relation"],
          confidence: 0,
          method: "rule",
          evidence: {},
        });
      for (const a of attachedArticles)
        sourceByArticle.set(a.id, canonicalSourceName(a.source, a.url));

      // classify every doc in publish order — a document is never
      // skipped because it was asserted before: a newer batch may bring
      // its true parent (or the peer coverage that confirms independence)
      const docIdsSorted = [...candidates]
        .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
        .map((c) => c.documentId);
      for (const docId of docIdsSorted) {
        const child = candById.get(docId)!;
        const prev = existing.get(docId);
        // a doc shared across events carries its provenance with it: the
        // stored parent — which lives in another event — re-enters the
        // pool to defend its assertion, so reclassification is a fair
        // contest. A stored derivation is only displaced by a BETTER
        // derivation (a matching parent that just joined this event);
        // 'original'/'unknown' here would mean "no parent visible in
        // THIS event's pool" — which the parent's absence already
        // explains, so it can never overwrite the recorded provenance.
        // a doc shared across events carries its provenance with it: the
        // stored parent — which lives in another event — re-enters the
        // pool to defend its assertion, so reclassification is a fair
        // contest. A stored derivation is only displaced by a BETTER
        // derivation (a matching parent that just joined this event);
        // 'original'/'unknown' here would mean "no parent visible in
        // THIS event's pool" — which the parent's absence already
        // explains, so it can never overwrite the recorded provenance.
        const childPool = candidates.filter((c) => c.documentId !== docId);
        const parentAbsent = prev?.parent && !candById.has(prev.parent);
        if (parentAbsent) {
          const oldParent = await loadLineageDoc(client, prev.parent!);
          if (!oldParent) continue; // unverifiable — never downgrade blind
          childPool.push(oldParent);
        }
        let asrt = classifyLineage(child, childPool);
        if (parentAbsent && !DERIVED.has(asrt.relation)) {
          asrt = {
            parentDocumentId: prev!.parent,
            relation: prev!.relation as LineageAssertion["relation"],
            confidence: 0,
            method: "rule",
            evidence: { reason: "kept_parent_outside_pool" },
          };
        }
        const changed =
          !prev ||
          prev.relation !== asrt.relation ||
          (prev.parent ?? null) !== (asrt.parentDocumentId ?? null);
        if (!changed) continue;
        assertionMap.set(docId, asrt);
        // cached root for debug; the read model re-walks the latest
        // graph so a re-pointed ancestor re-roots all descendants
        const origin = resolveOrigins(assertionMap).get(docId) ?? docId;
        await client.query(
          `INSERT INTO evidence_lineage
             (child_document_id, version_no, parent_document_id,
              origin_document_id, relation, confidence, method, evidence,
              classifier_version, supersedes_lineage_id)
           VALUES ($1, $2, $3, $4, $5::lineage_relation, $6, $7, $8::jsonb, $9, $10)`,
          [
            docId,
            prev ? prev.version_no + 1 : 1,
            asrt.parentDocumentId,
            asrt.parentDocumentId ? origin : null,
            asrt.relation,
            asrt.confidence,
            asrt.method,
            toJsonb(asrt.evidence),
            CLASSIFIER_VERSION,
            prev?.id ?? null,
          ],
        );
        if (
          prev &&
          prev.relation !== "original" &&
          asrt.relation === "original"
        )
          confirmedUpgrades.push({ docId, source: child.source });
        /* cross-event hand-off: if this doc is also attached to OTHER
         * events, their claim truth just changed — enqueue them for
         * re-adjudication (the current event is already covered by the
         * last_seen_at bump). Atomic with the lineage mint. */
        const { rows: shared } = await client.query<{ event_id: string }>(
          `SELECT DISTINCT ee.event_id FROM event_evidence ee
             JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
            WHERE ev.document_id = $1 AND ee.event_id <> $2`,
          [docId, eventId],
        );
        for (const s of shared)
          await enqueueDirty(
            client,
            s.event_id,
            "adjudicate",
            "ingest_relineage",
          );
        /* claim-grain hand-off: a provenance change on a doc backing a
         * claim (any version, any event) changes its materiality input */
        const { rows: touchedClaims } = await client.query<{
          claim_id: string;
        }>(
          `SELECT DISTINCT cv.claim_id FROM claim_evidence ce
             JOIN claim_versions cv ON cv.id = ce.claim_version_id
             JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
            WHERE ev.document_id = $1`,
          [docId],
        );
        for (const r of touchedClaims)
          await enqueueDirtyClaim(
            client,
            r.claim_id,
            "materiality",
            "ingest_relineage",
          );
      }
      // final relation per attached article (two articles can share a doc)
      for (const a of attachedArticles) {
        const docId = docByArticle.get(a.id)!;
        const rel =
          assertionMap.get(docId)?.relation ??
          existing.get(docId)?.relation ??
          "unknown";
        relByArticle.set(a.id, rel);
        if (batchDocIds.has(docId)) {
          if (rel === "original") lineageStats.original++;
          else if (rel === "unknown") lineageStats.unknown++;
          else lineageStats.derived++;
        }
      }
    }

    // stamp lineage relations back onto the ingest outcomes for telemetry
    for (const i of ingested) {
      if (i.articleId) i.relation = relByArticle.get(i.articleId);
    }

    // 4) claims — diff against the event's current truth-state.
    // Changes collect into `pending`; one material snapshot is minted
    // at most once per cycle by flushChanges.
    const changes: string[] = [];
    const pending: PlannedChange[] = [];
    for (const claim of claims) {
      const evId =
        (claim.articleId ? evByArticle.get(claim.articleId) : undefined) ??
        evBySource.get(claim.assertedBy) ??
        leadEvidenceId;
      // the vote's evidence-time — the asserting doc's own timestamp.
      // articleId match must win over the first same-source article:
      // borrowing a sibling article's timestamp can bypass stale checks
      claim.assertedAt ??=
        (claim.articleId &&
          cluster.articles.find((a) => a.id === claim.articleId)
            ?.publishedAt) ||
        cluster.articles.find((a) => a.source === claim.assertedBy)
          ?.publishedAt ||
        cluster.publishedAt;
      const assertingArticle =
        (claim.articleId
          ? cluster.articles.find((a) => a.id === claim.articleId)
          : undefined) ??
        cluster.articles.find((a) => a.source === claim.assertedBy);
      const assertedByCanon = canonicalSourceName(
        assertingArticle?.source ?? claim.assertedBy,
        assertingArticle?.url,
      );
      const assertedByPrimary = primarySources.has(assertedByCanon);
      const out = await upsertClaim(
        client,
        eventId,
        claim,
        assertedByPrimary,
        assertedByCanon,
      );
      if (evId) {
        // the document's stance describes how it relates to THIS version:
        // a disputing doc contradicts, a correcting/retracting doc
        // corrects, a primary that minted this truth-state originates,
        // everything else supports
        const stance =
          out.change?.type === "claim_disputed"
            ? "contradicts"
            : out.change?.type === "claim_corrected" ||
                out.change?.type === "claim_retracted"
              ? "corrects"
              : assertedByPrimary && out.change
                ? "originates"
                : "supports";
        const evidenceLinked = await linkClaimEvidence(
          client,
          out.claimVersionId,
          evId,
          stance,
          assertedByPrimary ? "direct" : "secondary",
          claim.method ?? "rule",
        );
        /* atomic hand-off to the materiality worker: a new truth value/
         * state or a newly linked evidence doc changes the claim's
         * scorer input — dirty it inside THIS transaction so the queue
         * commit is never separable from the write that stale-d it */
        if (out.change || evidenceLinked)
          await enqueueDirtyClaim(client, out.claimId, "materiality", "ingest");
      } else if (out.change) {
        // claim moved (value/state) with no evidence attached this round
        await enqueueDirtyClaim(client, out.claimId, "materiality", "ingest");
      }
      if (out.change) {
        changes.push(out.change.summary);
        // peripheral claims annotate history without minting event state —
        // a protocol fact is not a material event change, and its row drops
        // to low/medium so push channels never see it
        const peripheral = claim.salience === "peripheral";
        pending.push({
          type: out.change.type,
          summary: out.change.summary,
          claimId: out.claimId,
          fromClaimVersionId: out.fromClaimVersionId,
          toClaimVersionId: out.changeVersionId ?? out.claimVersionId,
          material: !peripheral,
          materiality: peripheral
            ? out.change.type === "claim_disputed"
              ? "medium"
              : "low"
            : undefined,
          reason:
            out.change.type === "new_claim"
              ? "new_material_claim"
              : out.change.type === "claim_disputed"
                ? "claim_disputed"
                : out.change.type === "claim_confirmed"
                  ? "primary_confirmation"
                  : out.change.type === "claim_corrected" ||
                      out.change.type === "claim_retracted"
                    ? "claim_corrected"
                    : "claim_updated",
        });
      }
    }

    // 5) material bookkeeping for evidence that arrived this round —
    // a primary source joining is material on its own (confirmation),
    // plain coverage with no claim change is logged but creates no version
    for (const e of newEvidence.filter((e) => e.primary)) {
      const summary = `Nguồn chính thức xác nhận tham gia: ${e.source}`;
      changes.push(summary);
      pending.push({
        type: "new_primary_source",
        summary,
        reason: "primary_confirmation",
      });
    }
    // information origins vs coverage: new_independent_evidence fires
    // ONLY when confirmedIndependentOrigins grows — a freshly attached
    // doc positively asserted 'original' (unknown/derived docs never
    // qualify), or an existing doc upgraded to 'original' this cycle.
    // Same-org re-reports never mint a new origin.
    const independents = newEvidence.filter(
      (e) =>
        !e.primary &&
        relByArticle.get(e.articleId) === "original" &&
        !priorSources.has(sourceByArticle.get(e.articleId) ?? ""),
    );
    const independentIds = new Set(independents.map((e) => e.articleId));
    const coverageOnly = newEvidence.filter(
      (e) => !e.primary && !independentIds.has(e.articleId),
    );
    if (!created) {
      for (const e of independents) {
        const summary = `Nguồn độc lập mới xác nhận: ${e.source}`;
        changes.push(summary);
        pending.push({
          type: "new_independent_evidence",
          summary,
          reason: "independent_origin",
        });
      }
      // late confirmation: an already-attached doc whose assertion
      // upgraded unknown/derived → original now counts once
      for (const u of confirmedUpgrades) {
        if (independents.some((e) => docByArticle.get(e.articleId) === u.docId))
          continue;
        const summary = `Nguồn độc lập mới xác nhận: ${u.source}`;
        changes.push(summary);
        pending.push({
          type: "new_independent_evidence",
          summary,
          reason: "independent_origin",
        });
      }
      // coverage (incl. unresolved-lineage arrivals) is logged at low
      // materiality even when other changes fire in the same cycle
      if (coverageOnly.length) {
        const summary = `+${coverageOnly.length} nguồn tường thuật lại cùng dữ kiện`;
        changes.push(summary);
        pending.push({
          type: "new_coverage",
          summary,
          material: false,
        });
      }
    }

    await flushChanges(client, eventId, pending, created);
    await client.query("COMMIT");
    return {
      eventId,
      created,
      evidenceAttached: attached,
      changes,
      ingested,
      lineage: lineageStats,
      materialChanges: pending.filter((p) => p.material !== false).length,
      primaryAttached: ingested.filter((i) => i.primary).length,
      resolverEvals,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * An event with no new evidence for RESOLVE_AFTER is wound down:
 * status → resolved, one terminal event_version, one change row.
 * Cheap heuristic — later replaced by topic-aware lifecycle rules.
 */
const RESOLVE_AFTER = "48 hours";

export async function resolveStaleEvents(): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const stale = await client.query<{ id: string; title: string }>(
      `SELECT e.id, ev.title
       FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
       WHERE e.status IN ('emerging', 'active', 'stable')
         AND e.last_seen_at < now() - interval '${RESOLVE_AFTER}'`,
    );
    let resolved = 0;
    for (const row of stale.rows) {
      await client.query("BEGIN");
      // Supabase disk-quota guard can leave default_transaction_read_only
      // on (Sept-27 incident: resolver_decisions bloat → silent pipeline
      // death). Force RW while it lingers; pg-mem can't parse SET
      // TRANSACTION — fine, tests aren't in a read-only tx anyway.
      await client.query("SET TRANSACTION READ WRITE").catch(() => {});
      const verId = await newEventVersion(client, row.id, "event_resolved", {
        status: "resolved",
      });
      await client.query(
        `UPDATE events SET status = 'resolved' WHERE id = $1`,
        [row.id],
      );
      await client.query(
        `INSERT INTO changes
           (event_id, to_event_version_id, type, materiality, summary,
            detected_at)
         VALUES ($1, $2, 'event_resolved', 'medium', $3, now())`,
        [row.id, verId, `Sự kiện lắng xuống: ${row.title}`],
      );
      await client.query("COMMIT");
      resolved++;
    }
    return resolved;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
