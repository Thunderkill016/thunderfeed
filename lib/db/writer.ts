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
import { getPool } from "./pool";
import { normalizeText } from "../model";
import { canonicalSourceName, mediaInfoFor } from "../mediaData";
import { entitySignature } from "../entities";
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
  resolveOrigins,
  type LineageAssertion,
  type LineageDoc,
} from "../lineage";
import type { Article, StoryCluster } from "../model";

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
 * Single-statement upsert — the no-op UPDATE keeps RETURNING usable on the
 * conflict path and avoids an in-process cache that could go stale.
 */
async function upsertSource(
  client: PoolClient,
  name: string,
  meta: SourceMeta = {},
): Promise<string> {
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
      meta.domain ?? null,
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
      ingest?.structuredData ? JSON.stringify(ingest.structuredData) : "{}",
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
        [documentId, JSON.stringify(mergedMeta)],
      );
      await client.query(
        `INSERT INTO evidence_metadata_observations
           (document_id, delta, snapshot)
         VALUES ($1, $2::jsonb, $3::jsonb)`,
        [documentId, JSON.stringify(delta), JSON.stringify(mergedMeta)],
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
      ingest?.structuredData ? JSON.stringify(ingest.structuredData) : "{}",
      JSON.stringify(mergedMeta ?? ingest?.structuredData ?? {}),
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
      article.title,
      article.summary || null,
      hash,
      now,
      // published_at and source_updated_at are different facts — only an
      // explicit upstream "updated/revised" timestamp belongs here
      ingest?.sourceUpdatedAt ?? null,
      supersedes,
      ingest?.structuredData ? JSON.stringify(ingest.structuredData) : null,
    ],
  );

  if (ver.rows[0]) {
    await client.query(
      `UPDATE evidence_documents
       SET current_version_id = $1, last_seen_at = $2
       WHERE id = $3`,
      [ver.rows[0].id, now, documentId],
    );
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
  return { eventId, eventVersionId, created: true };
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

async function resolveEvent(
  client: PoolClient,
  cluster: StoryCluster,
  claims: ExtractedClaim[],
  opts: {
    embedder?: (texts: string[]) => Promise<(number[] | null)[]>;
  } = {},
): Promise<{ ref: EventRef; evals: ResolverEval[] }> {
  const inc = buildIncomingSide(cluster, claims);
  const signature = inc.signature;
  const entSig = [...inc.entTokens].sort().join(" ");
  const entCoreSig = [...inc.entCoreTokens].sort().join(" ");

  const cands = await client.query<{
    id: string;
    signature: string;
    entity_signature: string;
    entity_signature_core: string;
    current_version_id: string;
    occurred_at: string | null;
    topic: string;
    title: string;
    summary: string | null;
  }>(
    `SELECT e.id, e.signature, e.entity_signature, e.entity_signature_core,
            e.current_version_id, e.occurred_at, e.topic,
            ev.title, ev.summary
     FROM events e
     LEFT JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged', 'archived')
       AND e.last_seen_at > now() - interval '${RESOLVER_MAX_WINDOW_HOURS} hours'`,
  );

  const evals: ResolverEval[] = [];
  // stage A-side feature state per candidate (claim space + rep text)
  const sides: {
    row: (typeof cands.rows)[number];
    cand: CandidateSide;
    rep: string;
    hash: string;
  }[] = [];
  for (const c of cands.rows) {
    // candidate's claim space: every versioned value (all positions),
    // so a cluster asserting an earlier position still matches
    const ck = await client.query<{
      claim_key: string;
      value: unknown;
    }>(
      `SELECT DISTINCT c.claim_key, cv.value
       FROM claims c
       JOIN claim_versions cv ON cv.claim_id = c.id
       WHERE c.event_id = $1`,
      [c.id],
    );
    const claimLabels = ck.rows
      .map((r) => `${r.claim_key}=${JSON.stringify(r.value)}`)
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
          ck.rows.map((r) => `${r.claim_key}|${JSON.stringify(r.value)}`),
        ),
        topic: c.topic,
        publishedAt: c.occurred_at ? Date.parse(c.occurred_at) : undefined,
        language: c.title ? detectLanguage(c.title) : undefined,
      },
      rep,
      hash: repHash(rep),
    });
  }

  // stage A recall filter — semantic retrieval widens the pool but never
  // merges on its own: it only earns the pair a scored evaluation.
  const incRep = clusterRepTextV2(cluster, claims);
  if (opts.embedder) {
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
    const texts = [incRep, ...missing.map((x) => x.rep)];
    const vectors = await opts.embedder(texts).catch(() => []);
    inc.embedding = vectors[0] ?? undefined;
    for (let i = 0; i < missing.length; i++) {
      const v = vectors[i + 1];
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
            JSON.stringify(v),
            missing[i].rep,
          ],
        )
        .catch(() => {});
    }
    for (const x of sides) {
      const hit = cacheHit.get(`${x.row.id}|${x.hash}`);
      if (hit) x.cand.embedding = hit;
    }
  }

  let best: (typeof cands.rows)[number] | null = null;
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
    if (d.decision === "merge" && d.score > bestScore) {
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
    await client.query(
      `UPDATE events
       SET last_seen_at = now(), entity_signature = $2,
           entity_signature_core = $3
       WHERE id = $1`,
      [best.id, [...merged].sort().join(" "), [...mergedCore].sort().join(" ")],
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
  // ON CONFLICT skips, and the SELECT is honest on real Postgres too
  const exists = await client.query(
    `SELECT 1 FROM event_evidence
     WHERE event_id = $1 AND evidence_version_id = $2`,
    [eventId, evidenceVersionId],
  );
  if (exists.rows.length > 0) return false;
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

/** Human-readable claim value — ranges render as "4.25–4.5", not raw JSON. */
const fmtClaimValue = (v: unknown): string => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    if (typeof r.low === "number" && typeof r.high === "number")
      return `${r.low}–${r.high}`;
  }
  return JSON.stringify(v);
};

interface ClaimOutcome {
  claimId: string;
  claimVersionId: string;
  /** claim_version superseded by this write — for change.from_claim_version_id */
  fromClaimVersionId?: string;
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
        CHANGE_MATERIALITY[p.type] ?? "low",
        p.summary,
      ],
    );
  }
}

/** claim_change_type → the change record it produces (null = version only) */
const CHANGE_RECORD: Record<string, string> = {
  confirmed: "claim_confirmed",
  disputed: "claim_disputed",
  corrected: "claim_corrected",
  retracted: "claim_retracted",
  value_changed: "claim_updated",
};

const mapState = (s: string) =>
  s === "confirmed" ||
  s === "disputed" ||
  s === "corrected" ||
  s === "retracted"
    ? s
    : null;

/**
 * One live position inside a claim: a value, the newest version carrying
 * it, and the set of sources whose LATEST assertion equals it.
 * A source that revises its number moves its vote — history keeps the
 * old assertion but the position loses the supporter.
 */
interface Position {
  valueJson: string;
  /** newest claim_version carrying this value */
  versionId: string;
  versionNo: number;
  /** sources whose latest assertion is this value */
  sources: Set<string>;
  hasPrimary: boolean;
  /** newest evidence-time among supporters — deterministic winner key */
  latestAt: number;
}

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
): Promise<ClaimOutcome> {
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(claim.value);
  // a claim originated by a primary source is born confirmed
  const state = claim.state ?? (isPrimary ? "confirmed" : "reported");

  const found = await client.query<{
    id: string;
    current_version_id: string;
    value: unknown;
    state: string;
    version_no: number;
  }>(
    `SELECT c.id, c.current_version_id, cv.value, cv.state, cv.version_no
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
        claim.qualifiers ? JSON.stringify(claim.qualifiers) : null,
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
      change: { type: "new_claim", summary: `Dữ kiện mới: ${claim.label}` },
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
    version_no: number;
    strength: string | null;
    vote_at: string;
  }>(
    `SELECT s.name, cv.value, cv.version_no,
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

  const latestVote = new Map<
    string,
    {
      valueJson: string;
      versionNo: number;
      primary: boolean;
      at: number;
    }
  >();
  const sortedVotes = [...votes.rows].sort(
    (a, b) =>
      Date.parse(a.vote_at) - Date.parse(b.vote_at) ||
      a.version_no - b.version_no,
  );
  for (const v of sortedVotes) {
    latestVote.set(v.name, {
      valueJson: JSON.stringify(v.value),
      versionNo: v.version_no,
      primary: v.strength === "direct",
      at: Date.parse(v.vote_at),
    });
  }

  const positions = new Map<string, Position>();
  let maxVersionNo = 0;
  for (const ver of vers.rows) {
    maxVersionNo = Math.max(maxVersionNo, ver.version_no);
    const vj = JSON.stringify(ver.value);
    const p =
      positions.get(vj) ??
      ({
        valueJson: vj,
        versionId: ver.id,
        versionNo: 0,
        sources: new Set(),
        hasPrimary: false,
        latestAt: 0,
      } satisfies Position);
    if (ver.version_no > p.versionNo) {
      p.versionId = ver.id;
      p.versionNo = ver.version_no;
    }
    positions.set(vj, p);
  }
  for (const [src, vote] of latestVote) {
    const p = positions.get(vote.valueJson);
    if (p) {
      p.sources.add(src);
      if (vote.primary) p.hasPrimary = true;
      p.latestAt = Math.max(p.latestAt, vote.at);
    }
  }

  const priorVote = latestVote.get(claim.assertedBy);
  const priorVoteJson = priorVote?.valueJson ?? null;
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
    if (!positions.has(valueJson))
      mint = { state: "disputed", changeType: "disputed" };
  } else if (priorVoteJson === valueJson) {
    // same-position re-assert — corroboration mints nothing
    if (explicit) mint = { state: claim.state!, changeType: explicit };
    else if (isPrimary && upgradeable)
      mint = { state: "confirmed", changeType: "confirmed" };
  } else if (priorVoteJson !== null) {
    // the source moved its own vote — self-revision
    mint = explicit
      ? { state: claim.state!, changeType: explicit }
      : { state: "corrected", changeType: "corrected" };
  } else if (positions.has(valueJson)) {
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
        claim.qualifiers ? JSON.stringify(claim.qualifiers) : null,
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

    const summary =
      priorVoteJson !== valueJson && priorVoteJson !== null
        ? `${claim.label} — ${fmtClaimValue(JSON.parse(priorVoteJson))} → ${fmtClaimValue(claim.value)}`
        : priorVoteJson !== valueJson && !positions.has(valueJson)
          ? `${claim.label} — ${fmtClaimValue(cur.value)} → ${fmtClaimValue(claim.value)}`
          : `${claim.label} — ${cur.state} → ${mint.state}`;
    if (!stale) {
      emitted = {
        type: CHANGE_RECORD[mint.changeType] ?? "claim_updated",
        summary,
      };
    }

    const p =
      positions.get(valueJson) ??
      ({
        valueJson,
        versionId: mintedId,
        versionNo: 0,
        sources: new Set(),
        hasPrimary: false,
        latestAt: 0,
      } satisfies Position);
    p.versionId = mintedId;
    p.versionNo = newVn;
    positions.set(valueJson, p);
  }

  // register this document's vote — a moved vote LEAVES its old position
  // (a self-correction withdraws support for the earlier figure).
  // A stale assertion moves nothing: the source stays at its newest vote.
  if (!stale && priorVoteJson !== null && priorVoteJson !== valueJson) {
    positions.get(priorVoteJson)?.sources.delete(claim.assertedBy);
  }
  const votePos = positions.get(valueJson);
  if (votePos && !stale) {
    votePos.sources.add(claim.assertedBy);
    if (isPrimary) votePos.hasPrimary = true;
    votePos.latestAt = Math.max(
      votePos.latestAt,
      claim.assertedAt ? Date.parse(claim.assertedAt) : Date.parse(now),
    );
  }

  /* ---- deterministic winner: never order-dependent ---- */
  // live positions = values holding at least one current supporter
  const livePositions = [...positions.values()].filter(
    (p) => p.sources.size > 0,
  );
  // every supporter retracted — fall back to the newest position so the
  // claim still has a standing version (the retraction itself)
  const ranked = livePositions.length ? livePositions : [...positions.values()];
  const primaryPos = ranked.filter((p) => p.hasPrimary);
  const winner = primaryPos.length
    ? primaryPos.sort(
        (a, b) =>
          b.latestAt - a.latestAt || a.valueJson.localeCompare(b.valueJson),
      )[0]
    : ranked.sort(
        (a, b) =>
          b.sources.size - a.sources.size ||
          a.valueJson.localeCompare(b.valueJson),
      )[0];

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
  const soleTerminal =
    livePositions.length === 1 &&
    (winnerVer?.state === "corrected" || winnerVer?.state === "retracted")
      ? winnerVer.state
      : null;
  const computedState =
    soleTerminal ??
    (winner.hasPrimary
      ? "confirmed"
      : livePositions.length > 1
        ? "disputed"
        : "reported");

  /* ---- converge current_version_id to the winner ---- */
  let currentVersionId = winner.versionId;
  if (winnerVer && winnerVer.state !== computedState) {
    // upgrade-only state mints: reported→confirmed, →disputed.
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
          JSON.parse(winner.valueJson),
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

  // corroboration moved the standing truth without minting anything —
  // record the consensus shift as a claim_updated against the winner version
  if (!mintedId && !emitted && winner.valueJson !== JSON.stringify(cur.value)) {
    emitted = {
      type: "claim_updated",
      summary: `Đồng thuận dịch chuyển: ${claim.label} — ${fmtClaimValue(cur.value)} → ${fmtClaimValue(JSON.parse(winner.valueJson))}`,
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
): Promise<void> {
  await client.query(
    `INSERT INTO claim_evidence
       (claim_version_id, evidence_version_id, stance, evidence_strength,
        extraction_method)
     VALUES ($1, $2, $3, $4::evidence_strength, $5::extraction_method)
     ON CONFLICT (claim_version_id, evidence_version_id) DO NOTHING`,
    [claimVersionId, evidenceVersionId, stance, evidenceStrength, method],
  );
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
    await client.query("BEGIN");

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
      if (primary) primarySources.add(article.source);
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
      { embedder: opts.embedder },
    );
    const { eventId, created } = evRef;

    // 2b) resolver telemetry — every evaluated pair is auditable
    for (const ev of resolverEvals) {
      await client
        .query(
          `INSERT INTO resolver_decisions
             (incoming_cluster, candidate_event_id, chosen_event_id,
              decision, path, score, reasons, hard_blocks, features,
              semantic_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
          [
            cluster.id,
            ev.candidateId,
            eventId,
            ev.decision.decision,
            ev.decision.path,
            ev.decision.score,
            JSON.stringify(ev.decision.reasons),
            JSON.stringify(ev.decision.hardBlocks),
            JSON.stringify(ev.decision.features ?? {}, (k, v) =>
              v instanceof Set ? [...v] : v,
            ),
            ev.decision.features?.semanticSimilarity !== undefined,
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
      const primary = primarySources.has(article.source);
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
        const asrt = classifyLineage(
          child,
          candidates.filter((c) => c.documentId !== docId),
        );
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
            JSON.stringify(asrt.evidence),
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
      // the vote's evidence-time — the asserting doc's own timestamp
      claim.assertedAt ??=
        cluster.articles.find(
          (a) => a.id === claim.articleId || a.source === claim.assertedBy,
        )?.publishedAt ?? cluster.publishedAt;
      const assertedByPrimary = primarySources.has(claim.assertedBy);
      const out = await upsertClaim(client, eventId, claim, assertedByPrimary);
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
        await linkClaimEvidence(
          client,
          out.claimVersionId,
          evId,
          stance,
          assertedByPrimary ? "direct" : "secondary",
          claim.method ?? "rule",
        );
      }
      if (out.change) {
        changes.push(out.change.summary);
        pending.push({
          type: out.change.type,
          summary: out.change.summary,
          claimId: out.claimId,
          fromClaimVersionId: out.fromClaimVersionId,
          toClaimVersionId: out.claimVersionId,
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
