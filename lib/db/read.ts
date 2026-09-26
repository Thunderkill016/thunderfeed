/**
 * Read layer — EventView projections for the API.
 * The UI renders this shape only; it never touches the versioned schema and
 * never computes "what changed" itself — changes arrive pre-computed.
 */

import { getPool } from "./pool";
import {
  extractEntitiesNormalized,
  entityKind,
  entityLabel,
  type EntityKind,
} from "../entities";
import { normalizeText } from "../model";

export interface EvidenceView {
  source: string;
  url: string;
  title: string;
  relationship: string;
  observedAt: string;
}

export interface ClaimView {
  id: string;
  predicate: string;
  claimType: string;
  value: unknown;
  unit: string | null;
  state: string;
  /** set when the current version superseded another — the "20 → 35" diff */
  previousValue?: unknown;
  changedAt?: string;
  evidenceCount: number;
  primaryEvidenceCount: number;
  /**
   * Live positions under dispute — each value with the sources whose
   * LATEST assertion holds it. Only present when ≥2 positions exist.
   */
  positions?: { value: unknown; sources: string[] }[];
}

export interface ChangeView {
  type: string;
  materiality: string;
  summary: string;
  detectedAt: string;
}

export interface EventVersionView {
  versionNo: number;
  title: string;
  status: string;
  effectiveAt: string;
  changeReason: string;
}

export interface EventView {
  id: string;
  title: string;
  summary: string;
  status: string;
  topic: string;
  firstSeenAt: string;
  lastUpdatedAt: string;
  /** canonical entities in signature order — kind null when the slug is
   *  outside the gazetteer (junction-only slug from an older taxonomy) */
  entities: { slug: string; label: string; kind: EntityKind | null }[];
  claims: ClaimView[];
  latestChanges: ChangeView[];
  /** canonical state history — append-only event_versions, newest first */
  versions: EventVersionView[];
  evidence: {
    primary: EvidenceView[];
    publishers: EvidenceView[];
    community: EvidenceView[];
  };
  confidence: {
    state: "weak" | "moderate" | "strong";
    directEvidenceCount: number;
    /** roots carrying a positive 'original' assertion — unresolved
     *  documents NEVER inflate this */
    confirmedIndependentOrigins: number;
    /** backwards compat: alias of confirmedIndependentOrigins */
    independentOrigins: number;
    /** documents whose lineage is unresolved ('unknown'/no assertion) —
     *  each is an unresolved root until evidence says otherwise */
    unresolvedOrigins: number;
    /** all publisher/primary/community documents on the event */
    rawSourceCount: number;
    /** roots whose root document is a primary source */
    primaryOrigins: number;
    /** documents derived from another document in the lineage graph */
    derivedDocuments: number;
    /** fraction of event documents with a lineage assertion (0-1) */
    lineageCoverage: number;
    /** claim_evidence rows asserting a conflicting value */
    contradictions: number;
  };
}

/**
 * ICD 203 / Heuer ACH: confidence is a judgment about evidence, so open
 * contradictions and murky provenance push it DOWN — a disputed claim or
 * a majority of unresolved origins can't sit under "strong".
 * strong: ≥1 primary-backed claim + ≥2 confirmed independent origins;
 * contradictions or an unresolved majority cap at moderate.
 */
export function confidenceState(input: {
  directEvidenceCount: number;
  confirmedIndependentOrigins: number;
  claimCount: number;
  contradictions: number;
  unresolvedOrigins: number;
}): "strong" | "moderate" | "weak" {
  let s: "strong" | "moderate" | "weak" =
    input.directEvidenceCount >= 1 && input.confirmedIndependentOrigins >= 2
      ? "strong"
      : input.claimCount >= 2 || input.confirmedIndependentOrigins >= 1
        ? "moderate"
        : "weak";
  if (
    s === "strong" &&
    (input.contradictions > 0 ||
      input.unresolvedOrigins > input.confirmedIndependentOrigins)
  )
    s = "moderate";
  return s;
}

/* ---- shared provenance walk: latest-parent chain, cycle-safe, depth-capped ---- */
const DERIVED_RELS = new Set([
  "syndicated",
  "quoted",
  "rewritten",
  "press_release_based",
]);

type LinEdge = { parent: string | null; relation: string };
type DocRow = { doc_id: string; source_id: string; kind: string };

/** Effective lineage root per doc — re-pointed docs re-root descendants. */
function effectiveRoots(
  docs: DocRow[],
  latestLin: Map<string, LinEdge>,
): {
  rootIds: Set<string>;
  confirmedIndependentOrigins: number;
  primaryOrigins: number;
  derivedDocuments: number;
  unresolvedOrigins: number;
} {
  const docById = new Map(docs.map((r) => [r.doc_id, r]));
  // dangling = the walk could not be verified INSIDE this doc set —
  // root outside the pool, a derivation cycle, or the depth cap. A
  // dangling origin is unknowable; it must count as unresolved or the
  // confidence cap sees "derived = resolved" on blind provenance.
  const rootOf = (id: string): { id: string; dangling: boolean } => {
    const seen = new Set<string>();
    let cur = id;
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(cur)) return { id: cur, dangling: true };
      seen.add(cur);
      const a = latestLin.get(cur);
      if (!a || !a.parent || !DERIVED_RELS.has(a.relation))
        return { id: cur, dangling: !docById.has(cur) && cur !== id };
      cur = a.parent;
    }
    return { id: cur, dangling: true };
  };
  const roots = new Map(docs.map((r) => [r.doc_id, rootOf(r.doc_id)]));
  const rootIds = new Set([...roots.values()].map((r) => r.id));
  // one newsroom = one origin: multiple asserted-original docs from the
  // same source still count as a single confirmed origin
  const confirmedSources = new Set<string>();
  const primarySources = new Set<string>();
  for (const rootId of rootIds) {
    const rootDoc = docById.get(rootId);
    if (!rootDoc) continue;
    if (latestLin.get(rootId)?.relation === "original")
      confirmedSources.add(rootDoc.source_id);
    if (rootDoc.kind === "primary") primarySources.add(rootDoc.source_id);
  }
  let derivedDocuments = 0;
  let unresolvedOrigins = 0;
  for (const r of docs) {
    const rel = latestLin.get(r.doc_id)?.relation;
    if (rel && DERIVED_RELS.has(rel)) {
      derivedDocuments++;
      if (roots.get(r.doc_id)!.dangling) unresolvedOrigins++;
    } else if (!rel || rel === "unknown") unresolvedOrigins++;
  }
  return {
    rootIds,
    confirmedIndependentOrigins: confirmedSources.size,
    primaryOrigins: primarySources.size,
    derivedDocuments,
    unresolvedOrigins,
  };
}

/** Latest lineage edge per child doc — shared by view + batch paths. */
async function latestLineage(docIds: string[]): Promise<Map<string, LinEdge>> {
  const latestLin = new Map<string, LinEdge>();
  if (!docIds.length) return latestLin;
  const linR = await getPool().query<{
    child_document_id: string;
    parent_document_id: string | null;
    relation: string;
  }>(
    `SELECT DISTINCT ON (child_document_id)
            child_document_id, parent_document_id, relation::text
     FROM evidence_lineage
     WHERE child_document_id IN (${docIds.map((_, i) => `$${i + 1}`).join(",")})
     ORDER BY child_document_id, version_no DESC`,
    docIds,
  );
  for (const r of linR.rows)
    latestLin.set(r.child_document_id, {
      parent: r.parent_document_id,
      relation: r.relation,
    });
  return latestLin;
}

export async function getEventView(eventId: string): Promise<EventView | null> {
  const pool = getPool();

  const ev = await pool.query<{
    id: string;
    topic: string;
    status: string;
    first_seen_at: string;
    last_seen_at: string;
    entity_signature: string;
    title: string;
    summary: string;
  }>(
    `SELECT e.id, e.topic, e.status, e.first_seen_at, e.last_seen_at,
            e.entity_signature, v.title, v.summary
     FROM events e
     JOIN event_versions v ON v.id = e.current_version_id
     WHERE e.id = $1`,
    [eventId],
  );
  const event = ev.rows[0];
  if (!event) return null;

  const claimsQ = pool.query<{
    id: string;
    claim_version_id: string;
    predicate: string;
    claim_type: string;
    value: unknown;
    unit: string | null;
    state: string;
    prev_value: unknown;
    changed_at: string | null;
  }>(
    `SELECT c.id, cv.id AS claim_version_id, c.predicate, c.claim_type,
            cv.value, cv.unit, cv.state, cv.observed_at AS changed_at,
            pv.value AS prev_value
     FROM claims c
     JOIN claim_versions cv ON cv.id = c.current_version_id
     LEFT JOIN claim_versions pv ON pv.id = cv.previous_version_id
     WHERE c.event_id = $1
     ORDER BY c.first_seen_at`,
    [eventId],
  );

  const claimCountsQ = pool.query<{
    claim_id: string;
    evidence_count: string;
    primary_evidence_count: string;
  }>(
    // count per CLAIM across all its versions — a synthesized winner
    // version (state convergence, consensus shift) carries no direct
    // claim_evidence rows yet still stands on the claim's full support
    `SELECT c.id AS claim_id,
            COUNT(*) AS evidence_count,
            SUM(CASE WHEN ce.evidence_strength = 'direct'
                     THEN 1 ELSE 0 END) AS primary_evidence_count
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id
     WHERE c.event_id = $1
     GROUP BY c.id`,
    [eventId],
  );

  const changesQ = pool.query<{
    type: string;
    materiality: string;
    summary: string;
    detected_at: string;
  }>(
    /* 40 raw rows (corroboration emits near-duplicate rows per evidence
     * version) — the modal dedups them into a readable catch-up arc */
    `SELECT type, materiality, summary, detected_at
     FROM changes WHERE event_id = $1
     ORDER BY detected_at DESC LIMIT 40`,
    [eventId],
  );

  const versionsQ = pool.query<{
    version_no: number;
    title: string;
    status: string;
    effective_at: string;
    change_reason: string;
  }>(
    `SELECT version_no, title, status::text, effective_at, change_reason::text
     FROM event_versions WHERE event_id = $1
     ORDER BY version_no DESC`,
    [eventId],
  );

  const evidenceQ = pool.query<{
    source: string;
    kind: string;
    url: string;
    title: string;
    relationship: string;
    observed_at: string;
  }>(
    `SELECT s.name AS source, s.kind, d.canonical_url AS url,
            ev.title, ee.relationship, ev.observed_at
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE ee.event_id = $1 AND ee.detached_at IS NULL
     ORDER BY ev.observed_at`,
    [eventId],
  );

  const positionsQ = pool.query<{
    claim_id: string;
    source: string;
    value: unknown;
    version_no: number;
    vote_at: string;
  }>(
    // latest vote per source must follow the writer's ordering — evidence
    // time (doc published_at, fallback observed_at), never ingestion order
    `SELECT c.id AS claim_id, s.name AS source, cv.value, cv.version_no,
            COALESCE(d.published_at, ev.observed_at) AS vote_at
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id
     JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE c.event_id = $1`,
    [eventId],
  );

  // Origins resolve from the LATEST lineage graph: each doc's newest
  // assertion gives its parent, roots are found by walking the chain —
  // the stored origin_document_id is a cache, never the source of truth.
  // A doc re-pointed to a primary (original → press_release_based)
  // re-roots every descendant automatically.
  const docsQ = pool.query<{
    doc_id: string;
    source_id: string;
    kind: string;
  }>(
    `SELECT DISTINCT d.id AS doc_id, s.id AS source_id, s.kind::text AS kind
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE ee.event_id = $1 AND ee.detached_at IS NULL`,
    [eventId],
  );

  const contradictionsQ = pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id
     WHERE c.event_id = $1 AND ce.stance = 'contradicts'`,
    [eventId],
  );

  const [
    claimsR,
    claimCountsR,
    changesR,
    versionsR,
    evidenceR,
    positionsR,
    docsR,
    contraR,
  ] = await Promise.all([
    claimsQ,
    claimCountsQ,
    changesQ,
    versionsQ,
    evidenceQ,
    positionsQ,
    docsQ,
    contradictionsQ,
  ]);

  // latest lineage assertions for this event's documents
  const docIds = docsR.rows.map((r) => r.doc_id);
  const latestLin = await latestLineage(docIds);

  const counts = new Map(
    claimCountsR.rows.map((r) => [
      r.claim_id,
      {
        evidence: Number(r.evidence_count),
        primary: Number(r.primary_evidence_count),
      },
    ]),
  );
  // positions: latest vote per source, grouped by value — mirrors the
  // writer's deterministic model so the UI can render "20: Reuters, AP /
  // 35: BBC" instead of a single flickering current value
  const positionsByClaim = new Map<
    string,
    { value: unknown; sources: string[] }[]
  >();
  {
    const latest = new Map<
      string,
      Map<string, { value: unknown; vn: number; at: number }>
    >();
    for (const r of positionsR.rows) {
      const per = latest.get(r.claim_id) ?? new Map();
      const cur = per.get(r.source);
      const at = Date.parse(r.vote_at);
      if (!cur || at > cur.at || (at === cur.at && r.version_no > cur.vn))
        per.set(r.source, { value: r.value, vn: r.version_no, at });
      latest.set(r.claim_id, per);
    }
    for (const [claimId, per] of latest) {
      const byValue = new Map<string, { value: unknown; sources: string[] }>();
      for (const [source, v] of per) {
        const key = JSON.stringify(v.value);
        const p = byValue.get(key) ?? { value: v.value, sources: [] };
        p.sources.push(source);
        byValue.set(key, p);
      }
      const positions = [...byValue.values()].sort(
        (a, b) => b.sources.length - a.sources.length,
      );
      if (positions.length > 1) positionsByClaim.set(claimId, positions);
    }
  }

  const claims: ClaimView[] = claimsR.rows.map((r) => {
    const n = counts.get(r.id);
    return {
      id: r.id,
      predicate: r.predicate,
      claimType: r.claim_type,
      value: r.value,
      unit: r.unit,
      state: r.state,
      previousValue: r.prev_value ?? undefined,
      changedAt:
        r.prev_value !== null && r.prev_value !== undefined
          ? r.changed_at!
          : undefined,
      evidenceCount: n?.evidence ?? 0,
      primaryEvidenceCount: n?.primary ?? 0,
      positions: positionsByClaim.get(r.id),
    };
  });

  const bucket = {
    primary: [] as EvidenceView[],
    publishers: [] as EvidenceView[],
    community: [] as EvidenceView[],
  };
  for (const r of evidenceR.rows) {
    const view: EvidenceView = {
      source: r.source,
      url: r.url,
      title: r.title,
      relationship: r.relationship,
      observedAt: r.observed_at,
    };
    if (r.kind === "primary" || r.relationship === "primary_evidence") {
      bucket.primary.push(view);
    } else if (r.kind === "community" || r.kind === "aggregator") {
      bucket.community.push(view);
    } else {
      bucket.publishers.push(view);
    }
  }

  // a retracted claim's evidence is dead support — the primary DID assert
  // it, but the standing truth is that it withdrew. Counting it as live
  // direct evidence inflates 'strong' past ICD 203's disconfirm rule.
  const directEvidenceCount = claims.reduce(
    (n, c) => n + (c.state === "retracted" ? 0 : c.primaryEvidenceCount),
    0,
  );
  // resolve each doc's effective root by walking latest parent links;
  // stored origin_document_id is only a cache
  const {
    confirmedIndependentOrigins,
    primaryOrigins,
    derivedDocuments,
    unresolvedOrigins,
  } = effectiveRoots(docsR.rows, latestLin);
  const rawSourceCount = new Set(docsR.rows.map((r) => r.source_id)).size;
  const contradictions = Number(contraR.rows[0]?.n ?? 0);
  const state = confidenceState({
    directEvidenceCount,
    confirmedIndependentOrigins,
    claimCount: claims.length,
    contradictions,
    unresolvedOrigins,
  });

  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    status: event.status,
    topic: event.topic,
    firstSeenAt: event.first_seen_at,
    lastUpdatedAt: event.last_seen_at,
    entities: event.entity_signature
      .split(" ")
      .filter(Boolean)
      .map((slug) => ({
        slug,
        label: entityLabel(slug),
        kind: entityKind(slug),
      })),
    claims,
    latestChanges: changesR.rows.map((r) => ({
      type: r.type,
      materiality: r.materiality,
      summary: r.summary,
      detectedAt: r.detected_at,
    })),
    versions: versionsR.rows.map((r) => ({
      versionNo: r.version_no,
      title: r.title,
      status: r.status,
      effectiveAt: r.effective_at,
      changeReason: r.change_reason,
    })),
    evidence: bucket,
    confidence: {
      state,
      directEvidenceCount,
      confirmedIndependentOrigins,
      independentOrigins: confirmedIndependentOrigins,
      unresolvedOrigins,
      rawSourceCount,
      primaryOrigins,
      derivedDocuments,
      lineageCoverage: docsR.rows.length
        ? latestLin.size / docsR.rows.length
        : 0,
      contradictions,
    },
  };
}

/**
 * Which changes a channel should surface. `tiers` is the materiality
 * allowlist; `alsoTypes` ORs in specific change types at ANY tier —
 * e.g. a brand-new event is alert-worthy even at medium while yet
 * another independent confirmation is not.
 */
export interface ChangeChannelFilter {
  tiers?: readonly string[];
  alsoTypes?: readonly string[];
  /** gate on the event's CURRENT importance (ev = current_version join);
   *  changes on minor events stay on the rail, not the push channel */
  minImportance?: number;
  /** change types exempt from the importance gate — a brand-new event has
   *  no score yet but is exactly what a push channel exists for */
  importanceExemptTypes?: readonly string[];
}

const MATERIALITY_TIERS = new Set(["low", "medium", "high"]);

function channelFilterClause(f?: ChangeChannelFilter): string {
  const tiers = (f?.tiers ?? ["medium", "high"]).filter((t) =>
    MATERIALITY_TIERS.has(t),
  );
  // change types are internal constants — strip quotes defensively anyway
  const safe = (t: string) => `'${t.replace(/'/g, "")}'`;
  const also = (f?.alsoTypes ?? []).map(safe);
  const parts: string[] = [];
  if (tiers.length)
    parts.push(`ch.materiality IN (${tiers.map((t) => `'${t}'`).join(",")})`);
  if (also.length) parts.push(`ch.type IN (${also.join(",")})`);
  if (!parts.length) return "FALSE";
  let clause = `(${parts.join(" OR ")})`;
  if (f?.minImportance !== undefined) {
    const exempt = (f.importanceExemptTypes ?? []).map(safe);
    const gate = `COALESCE(ev.importance_score, -1) >= ${Number(f.minImportance) || 0}`;
    clause += ` AND (${exempt.length ? `ch.type IN (${exempt.join(",")}) OR ` : ""}${gate})`;
  }
  return clause;
}

/** Feed of material changes across all live events — the "WHAT CHANGED" rail. */
export async function getLatestChanges(
  limit = 30,
  filter?: ChangeChannelFilter,
): Promise<
  (ChangeView & { id: string; eventId: string; eventTitle: string })[]
> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    title: string;
    type: string;
    materiality: string;
    summary: string;
    detected_at: string;
  }>(
    `SELECT ch.id, ch.event_id, ev.title, ch.type, ch.materiality,
            ch.summary, ch.detected_at
     FROM changes ch
     JOIN events e ON e.id = ch.event_id
     JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged', 'archived')
       AND ${channelFilterClause(filter)}
     ORDER BY ch.detected_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventTitle: r.title,
    type: r.type,
    materiality: r.materiality,
    summary: r.summary,
    detectedAt: r.detected_at,
  }));
}

/**
 * Material changes on events whose canonical entity set intersects the
 * user's watched slugs — the alert layer of the personal-mission loop.
 * Slug matching runs on the event_entities junction (the resolver's
 * signature exploded once at write time), so watch topics hit an index
 * instead of a per-row string split.
 */
export async function getChangesForEntities(
  entities: string[],
  limit = 30,
  filter?: ChangeChannelFilter,
): Promise<
  (ChangeView & { id: string; eventId: string; eventTitle: string })[]
> {
  if (entities.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    event_id: string;
    title: string;
    type: string;
    materiality: string;
    summary: string;
    detected_at: string;
  }>(
    `SELECT ch.id, ch.event_id, ev.title, ch.type, ch.materiality,
            ch.summary, ch.detected_at
     FROM changes ch
     JOIN events e ON e.id = ch.event_id
     JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged', 'archived')
       AND ${channelFilterClause(filter)}
       AND e.id IN (
         SELECT ee.event_id FROM event_entities ee
         WHERE ee.entity_slug IN (${entities.map((_, i) => `$${i + 2}`).join(",")})
       )
     ORDER BY ch.detected_at DESC
     LIMIT $1`,
    [limit, ...entities],
  );
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventTitle: r.title,
    type: r.type,
    materiality: r.materiality,
    summary: r.summary,
    detectedAt: r.detected_at,
  }));
}

/** Every live event carrying a canonical entity slug — the entity-page
 *  read behind "theo dõi Fed": junction rows, newest activity first. */
export async function getEntityEvents(slug: string): Promise<{
  slug: string;
  label: string;
  kind: EntityKind | null;
  events: {
    id: string;
    title: string;
    status: string;
    topic: string;
    importance: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
    changeCount: number;
    /** slug anchored at least one merged cluster's title — headline
     *  entity, not a passing mention (RavenPack-style relevance tier) */
    inTitle: boolean;
  }[];
  /** entities co-occurring on the same events — the junction's
   *  co-mention graph, ordered by shared-event count */
  related: {
    slug: string;
    label: string;
    kind: EntityKind | null;
    shared: number;
  }[];
}> {
  const pool = getPool();
  const relatedQ = pool.query<{
    entity_slug: string;
    shared: string;
  }>(
    `SELECT ee2.entity_slug, count(*) AS shared
     FROM event_entities ee1
     JOIN event_entities ee2
       ON ee2.event_id = ee1.event_id AND ee2.entity_slug <> $1
     JOIN events e ON e.id = ee2.event_id
     WHERE ee1.entity_slug = $1
       AND e.status NOT IN ('merged', 'archived')
     GROUP BY ee2.entity_slug
     ORDER BY shared DESC, ee2.entity_slug
     LIMIT 8`,
    [slug],
  );
  const { rows } = await pool.query<{
    id: string;
    title: string;
    status: string;
    topic: string;
    importance: number | null;
    first_seen_at: string;
    last_seen_at: string;
    change_count: string;
    in_title: boolean;
  }>(
    `SELECT e.id, ev.title, e.status, e.topic,
            ev.importance_score AS importance,
            e.first_seen_at, e.last_seen_at,
            count(ch.id) AS change_count, ee.in_title
     FROM event_entities ee
     JOIN events e ON e.id = ee.event_id
     JOIN event_versions ev ON ev.id = e.current_version_id
     LEFT JOIN changes ch ON ch.event_id = e.id
     WHERE ee.entity_slug = $1
       AND e.status NOT IN ('merged', 'archived')
     GROUP BY e.id, ev.title, e.status, e.topic,
              ev.importance_score, e.first_seen_at, e.last_seen_at,
              ee.in_title
     ORDER BY ee.in_title DESC, e.last_seen_at DESC`,
    [slug],
  );
  const related = (await relatedQ).rows.map((r) => ({
    slug: r.entity_slug,
    label: entityLabel(r.entity_slug),
    kind: entityKind(r.entity_slug),
    shared: Number(r.shared),
  }));
  return {
    slug,
    label: entityLabel(slug),
    kind: entityKind(slug),
    events: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      topic: r.topic,
      importance: r.importance,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      changeCount: Number(r.change_count),
      inTitle: r.in_title,
    })),
    related,
  };
}

export interface EventListItem {
  id: string;
  title: string;
  status: string;
  topic: string;
  firstSeenAt: string;
  lastSeenAt: string;
  claimCount: number;
  sourceCount: number;
  lastMaterialType?: string;
  lastMaterialAt?: string;
}

/**
 * The events index — one row per live event with its current version,
 * claim/source counts and the last material change (coverage is ignored
 * by the materiality filter; last_seen stays distinct from last_material).
 */
export async function getRecentEvents(limit = 30): Promise<EventListItem[]> {
  const pool = getPool();
  const { rows: events } = await pool.query<{
    id: string;
    title: string;
    status: string;
    topic: string;
    first_seen_at: string;
    last_seen_at: string;
  }>(
    `SELECT e.id, ev.title, e.status, e.topic,
            e.first_seen_at, e.last_seen_at
     FROM events e
     JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged', 'archived')
     ORDER BY e.last_seen_at DESC
     LIMIT $1`,
    [limit],
  );
  if (events.length === 0) return [];
  const ids = events.map((e) => e.id);

  const claimsQ = await pool.query<{ event_id: string; c: string }>(
    `SELECT event_id, COUNT(*) AS c FROM claims
     WHERE event_id = ANY($1) GROUP BY event_id`,
    [ids],
  );
  const claimCount = new Map(
    claimsQ.rows.map((r) => [r.event_id, Number(r.c)]),
  );

  const srcQ = await pool.query<{ event_id: string; c: string }>(
    `SELECT ee.event_id, COUNT(DISTINCT ed.source_id) AS c
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents ed ON ed.id = ev.document_id
     WHERE ee.event_id = ANY($1)
     GROUP BY ee.event_id`,
    [ids],
  );
  const sourceCount = new Map(srcQ.rows.map((r) => [r.event_id, Number(r.c)]));

  const matQ = await pool.query<{
    event_id: string;
    type: string;
    detected_at: string;
  }>(
    `SELECT DISTINCT ON (event_id) event_id, type, detected_at FROM changes
     WHERE materiality <> 'low' AND event_id = ANY($1)
     ORDER BY event_id, detected_at DESC`,
    [ids],
  );
  const lastMaterial = new Map<string, { type: string; detected_at: string }>();
  for (const r of matQ.rows)
    if (!lastMaterial.has(r.event_id)) lastMaterial.set(r.event_id, r);

  return events.map((e) => {
    const m = lastMaterial.get(e.id);
    return {
      id: e.id,
      title: e.title,
      status: e.status,
      topic: e.topic,
      firstSeenAt: e.first_seen_at,
      lastSeenAt: e.last_seen_at,
      claimCount: claimCount.get(e.id) ?? 0,
      sourceCount: sourceCount.get(e.id) ?? 0,
      lastMaterialType: m?.type,
      lastMaterialAt: m?.detected_at,
    };
  });
}

/** Canonical claim counts per event — powers the "N dữ kiện" chip on cards. */
export async function getClaimCounts(
  eventIds: string[],
): Promise<Map<string, number>> {
  const pool = getPool();
  if (!pool || eventIds.length === 0) return new Map();
  const r = await pool.query<{ event_id: string; c: string }>(
    `SELECT event_id, COUNT(*) AS c FROM claims
     WHERE event_id = ANY($1) GROUP BY event_id`,
    [eventIds],
  );
  return new Map(r.rows.map((x) => [x.event_id, Number(x.c)]));
}

/**
 * Batched ICD 203 confidence per event — same rules as getEventView's
 * confidence block, computed in 4 grouped queries instead of per-event
 * views. Powers the reliability chip on edition cards.
 */
export async function getConfidenceStates(
  eventIds: string[],
): Promise<Map<string, "strong" | "moderate" | "weak">> {
  const pool = getPool();
  const out = new Map<string, "strong" | "moderate" | "weak">();
  if (!pool || eventIds.length === 0) return out;

  const claimsQ = pool.query<{
    event_id: string;
    claim_count: string;
    direct_count: string;
  }>(
    // per-claim support across all versions (a synthesized standing
    // version carries no links yet still stands on the claim's evidence),
    // but a retracted claim's support is dead — never live direct evidence
    `SELECT c.event_id,
            COUNT(DISTINCT c.id) AS claim_count,
            COUNT(*) FILTER (WHERE ce.evidence_strength = 'direct'
                             AND cur.state <> 'retracted') AS direct_count
     FROM claims c
     JOIN claim_versions cur ON cur.id = c.current_version_id
     JOIN claim_versions cv ON cv.claim_id = c.id
     LEFT JOIN claim_evidence ce ON ce.claim_version_id = cv.id
     WHERE c.event_id = ANY($1)
     GROUP BY c.event_id`,
    [eventIds],
  );
  const docsQ = pool.query<{
    event_id: string;
    doc_id: string;
    source_id: string;
    kind: string;
  }>(
    `SELECT DISTINCT ee.event_id, d.id AS doc_id, s.id AS source_id,
            s.kind::text AS kind
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE ee.event_id = ANY($1) AND ee.detached_at IS NULL`,
    [eventIds],
  );
  const contraQ = pool.query<{ event_id: string; n: string }>(
    `SELECT c.event_id, COUNT(*) AS n
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id
     WHERE c.event_id = ANY($1) AND ce.stance = 'contradicts'
     GROUP BY c.event_id`,
    [eventIds],
  );
  const [claimsR, docsR, contraR] = await Promise.all([
    claimsQ,
    docsQ,
    contraQ,
  ]);

  const latestLin = await latestLineage([
    ...new Set(docsR.rows.map((r) => r.doc_id)),
  ]);

  const claimsBy = new Map(
    claimsR.rows.map((r) => [
      r.event_id,
      { claims: Number(r.claim_count), direct: Number(r.direct_count) },
    ]),
  );
  const contraBy = new Map(contraR.rows.map((r) => [r.event_id, Number(r.n)]));
  const docsBy = new Map<string, DocRow[]>();
  for (const r of docsR.rows) {
    const list = docsBy.get(r.event_id) ?? [];
    list.push({ doc_id: r.doc_id, source_id: r.source_id, kind: r.kind });
    docsBy.set(r.event_id, list);
  }

  for (const eventId of eventIds) {
    const docs = docsBy.get(eventId) ?? [];
    const prov = effectiveRoots(docs, latestLin);
    const c = claimsBy.get(eventId);
    out.set(
      eventId,
      confidenceState({
        directEvidenceCount: c?.direct ?? 0,
        confirmedIndependentOrigins: prov.confirmedIndependentOrigins,
        claimCount: c?.claims ?? 0,
        contradictions: contraBy.get(eventId) ?? 0,
        unresolvedOrigins: prov.unresolvedOrigins,
      }),
    );
  }
  return out;
}

export interface EventSearchHit {
  id: string;
  title: string;
  summary: string;
  status: string;
  topic: string;
  lastUpdatedAt: string;
  /** 0-1 deterministic rank — entity hits dominate, token overlap breaks ties */
  score: number;
}

/**
 * Deterministic event search for Ask — canonical events only (never raw
 * articles). Entity slugs from the query are matched against the persisted
 * entity_signature; remaining query tokens must appear in the normalized
 * title+summary. Resolved events decay out unless nothing else matches.
 */
export async function searchEvents(
  query: string,
  limit = 6,
): Promise<EventSearchHit[]> {
  const pool = getPool();
  const norm = normalizeText(query);
  if (!norm) return [];
  const queryEntities = new Set(extractEntitiesNormalized(norm));
  const tokens = norm.split(" ").filter((t) => t.length >= 3);

  const r = await pool.query<{
    id: string;
    title: string;
    summary: string;
    status: string;
    topic: string;
    last_seen_at: string;
    entity_signature: string;
  }>(
    `SELECT e.id, v.title, v.summary, e.status::text, e.topic::text,
            e.last_seen_at, e.entity_signature
     FROM events e
     JOIN event_versions v ON v.id = e.current_version_id
     WHERE e.status <> 'resolved'
        OR e.last_seen_at > now() - interval '14 days'`,
  );

  const scored = r.rows
    .map((row) => {
      const sig = new Set(row.entity_signature.split(" ").filter(Boolean));
      let entityHits = 0;
      for (const s of queryEntities) if (sig.has(s)) entityHits++;
      const hay = normalizeText(`${row.title} ${row.summary}`);
      const tokenHits = tokens.filter((t) => hay.includes(t)).length;
      // no entity in query → require at least one token hit to rank at all
      if (entityHits === 0 && (queryEntities.size > 0 || tokenHits === 0))
        return null;
      const tokenRatio = tokens.length ? tokenHits / tokens.length : 0;
      const entityRatio = queryEntities.size
        ? entityHits / queryEntities.size
        : 0;
      const score = Math.min(
        1,
        entityRatio * 0.7 + tokenRatio * 0.3 + (entityHits > 0 ? 0.15 : 0),
      );
      if (score < 0.2) return null;
      return { row, score };
    })
    .filter((x): x is { row: (typeof r.rows)[number]; score: number } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    topic: row.topic,
    lastUpdatedAt: row.last_seen_at,
    score,
  }));
}

export interface SourceReliability {
  sourceId: string;
  name: string;
  kind: string;
  documents: number;
  /** lineage roots carrying 'original' — genuinely own reporting */
  originals: number;
  /** syndicated/quoted/rewritten/press_release_based documents */
  derived: number;
  /** 'unknown' relation or no lineage assertion at all */
  unknownLineage: number;
  /** assertions this source made on claims (claim_evidence rows) */
  claimsAsserted: number;
  /** of those claims, CURRENT state distribution */
  confirmed: number;
  disputed: number;
  corrected: number;
  /** 0-1 composite; see formula below — deterministic, explainable */
  score: number;
  tier: "strong" | "moderate" | "weak" | "insufficient";
}

const RELIABILITY_MIN_DOCS = 5;

/**
 * Per-source reliability from observed behavior only — no external ratings.
 *   originality   = lineage 'original' roots / documents
 *   unknownShare  = unresolved provenance / documents        (penalty)
 *   confirmRate   = claims now 'confirmed' / assertions
 *   correctedRate = claims now corrected|retracted / assertions (penalty)
 *   score = 0.5·originality + 0.5·confirmRate − 0.5·correctedRate − 0.25·unknownShare
 * Sources under RELIABILITY_MIN_DOCS get tier 'insufficient' — a score on
 * thin evidence would be noise presented as signal.
 */
export async function getSourceReliability(): Promise<SourceReliability[]> {
  const pool = getPool();
  const docsQ = pool.query<{
    source_id: string;
    name: string;
    kind: string;
    docs: string;
    originals: string;
    derived: string;
    unknown: string;
  }>(
    `WITH latest_lin AS (
       SELECT DISTINCT ON (child_document_id)
              child_document_id, relation::text AS relation
       FROM evidence_lineage
       ORDER BY child_document_id, version_no DESC
     )
     SELECT s.id AS source_id, s.name, s.kind::text,
            COUNT(d.id) AS docs,
            COUNT(*) FILTER (WHERE ll.relation = 'original') AS originals,
            COUNT(*) FILTER (WHERE ll.relation IN
              ('syndicated','quoted','rewritten','press_release_based')) AS derived,
            COUNT(*) FILTER (WHERE ll.relation IS NULL
                             OR ll.relation = 'unknown') AS unknown
     FROM sources s
     JOIN evidence_documents d ON d.source_id = s.id
     LEFT JOIN latest_lin ll ON ll.child_document_id = d.id
     GROUP BY s.id, s.name, s.kind`,
  );
  // claim state resolves via claims.current_version_id — the asserting
  // version's state is irrelevant, what matters is where the claim ended
  const claimsQ2 = pool.query<{
    source_id: string;
    asserted: string;
    confirmed: string;
    disputed: string;
    corrected: string;
  }>(
    `SELECT s.id AS source_id,
            COUNT(*) AS asserted,
            COUNT(*) FILTER (WHERE cur.state = 'confirmed') AS confirmed,
            COUNT(*) FILTER (WHERE cur.state = 'disputed') AS disputed,
            COUNT(*) FILTER (WHERE cur.state IN ('corrected','retracted')) AS corrected
     FROM claim_evidence ce
     JOIN claim_versions v ON v.id = ce.claim_version_id
     JOIN claims c ON c.id = v.claim_id
     JOIN claim_versions cur ON cur.id = c.current_version_id
     JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     GROUP BY s.id`,
  );
  const [docsR, claimsR] = await Promise.all([docsQ, claimsQ2]);

  const claimStats = new Map(claimsR.rows.map((r) => [r.source_id, r]));
  return docsR.rows
    .map((r) => {
      const cs = claimStats.get(r.source_id);
      const docs = Number(r.docs);
      const originals = Number(r.originals);
      const derived = Number(r.derived);
      const unknown = Number(r.unknown);
      const asserted = Number(cs?.asserted ?? 0);
      const confirmed = Number(cs?.confirmed ?? 0);
      const disputed = Number(cs?.disputed ?? 0);
      const corrected = Number(cs?.corrected ?? 0);

      const originality = docs ? originals / docs : 0;
      const unknownShare = docs ? unknown / docs : 0;
      const confirmRate = asserted ? confirmed / asserted : 0;
      const correctedRate = asserted ? corrected / asserted : 0;
      const score = Math.max(
        0,
        Math.min(
          1,
          0.5 * originality +
            0.5 * confirmRate -
            0.5 * correctedRate -
            0.25 * unknownShare,
        ),
      );
      const tier: SourceReliability["tier"] =
        docs < RELIABILITY_MIN_DOCS
          ? "insufficient"
          : score >= 0.6
            ? "strong"
            : score >= 0.35
              ? "moderate"
              : "weak";

      return {
        sourceId: r.source_id,
        name: r.name,
        kind: r.kind,
        documents: docs,
        originals,
        derived,
        unknownLineage: unknown,
        claimsAsserted: asserted,
        confirmed,
        disputed,
        corrected,
        score: Math.round(score * 100) / 100,
        tier,
      };
    })
    .sort((a, b) => b.score - a.score || b.documents - a.documents);
}
