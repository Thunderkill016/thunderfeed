/**
 * Read layer — EventView projections for the API.
 * The UI renders this shape only; it never touches the versioned schema and
 * never computes "what changed" itself — changes arrive pre-computed.
 */

import type { Pool } from "pg";
import { getPool } from "./pool";
import {
  canonicalEntity,
  extractEntitiesNormalized,
  entityKind,
  entityLabel,
  kindOfType,
  type EntityKind,
} from "../entities";
import { normalizeText } from "../model";
import { normalizeDecimalString } from "../market";
import { caDivergentFields } from "../corporate-actions";

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
  /** canonical entities attached via the junction — entityId/canonicalKey
   *  are the durable identity; slug+kind kept for transitional reads */
  entities: {
    slug: string;
    entityId: string | null;
    canonicalKey: string | null;
    type: string | null;
    label: string;
    kind: EntityKind | null;
    inTitle: boolean;
  }[];
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

  const entitiesQ = pool.query<{
    entity_slug: string;
    entity_id: string | null;
    canonical_key: string | null;
    entity_type: string | null;
    canonical_name: string | null;
    in_title: boolean;
  }>(
    `SELECT ee.entity_slug, ee.entity_id, ee.in_title,
            en.canonical_key, en.entity_type, en.canonical_name
     FROM event_entities ee
     LEFT JOIN entities en ON en.id = ee.entity_id
     WHERE ee.event_id = $1
     ORDER BY ee.first_seen_at, ee.entity_slug`,
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
    entitiesR,
    contraR,
  ] = await Promise.all([
    claimsQ,
    claimCountsQ,
    changesQ,
    versionsQ,
    evidenceQ,
    positionsQ,
    docsQ,
    entitiesQ,
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
    entities: entitiesR.rows.map((r) => ({
      slug: r.entity_slug,
      entityId: r.entity_id,
      canonicalKey: r.canonical_key,
      type: r.entity_type,
      label: r.canonical_name ?? entityLabel(r.entity_slug),
      kind: kindOfType(r.entity_type) ?? entityKind(r.entity_slug),
      inTitle: r.in_title,
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

/** Data-layer delta feed — macro releases/revisions and corporate-action
 *  transitions, the data twin of the `changes` rail. */
export interface DataDeltaView {
  id: string;
  kind: string;
  materiality: string;
  summary: string;
  detectedAt: string;
  seriesKey: string | null;
  seriesCode: string | null;
  entityKey: string | null;
  actionType: string | null;
  instrumentKey: string | null;
}

export async function getLatestDataDeltas(
  limit = 30,
): Promise<DataDeltaView[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    kind: string;
    materiality: string;
    summary: string;
    detected_at: string;
    series_key: string | null;
    series_code: string | null;
    entity_key: string | null;
    action_type: string | null;
    instrument_key: string | null;
  }>(
    `SELECT d.id, d.kind, d.materiality, d.summary, d.detected_at,
            s.canonical_key AS series_key, s.series_code,
            e.canonical_key AS entity_key,
            a.action_type,
            COALESCE(i.canonical_key, fi.canonical_key) AS instrument_key
       FROM data_deltas d
       LEFT JOIN macro_points p ON p.id = d.point_id
       LEFT JOIN macro_series s ON s.id = p.series_id
       LEFT JOIN entities e ON e.id = s.entity_id
       LEFT JOIN corporate_actions a ON a.id = d.action_id
       LEFT JOIN financial_instruments i ON i.id = a.instrument_id
       LEFT JOIN market_points mp ON mp.id = d.market_point_id
       LEFT JOIN market_series ms ON ms.id = mp.series_id
       LEFT JOIN instrument_listings il ON il.id = ms.listing_id
       LEFT JOIN financial_instruments fi ON fi.id = il.instrument_id
      ORDER BY d.detected_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    materiality: r.materiality,
    summary: r.summary,
    detectedAt: r.detected_at,
    seriesKey: r.series_key,
    seriesCode: r.series_code,
    entityKey: r.entity_key,
    actionType: r.action_type,
    instrumentKey: r.instrument_key,
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
  // legacy slugs (watch storage) resolve to canonical ids; junction rows
  // pre-migration stay reachable via the slug clause — a slug that
  // resolves nothing still queries literally, never silently widened
  const resolved = await Promise.all(entities.map(resolveEntityRef));
  const ids = resolved.map((r) => r?.id).filter((v): v is string => !!v);
  const orphanSlugs = entities.filter((_, i) => !resolved[i]);
  const clauses: string[] = [];
  let p = 1; // $1 is limit
  if (ids.length)
    clauses.push(`ee.entity_id IN (${ids.map(() => `$${++p}`).join(",")})`);
  if (orphanSlugs.length)
    clauses.push(
      `ee.entity_slug IN (${orphanSlugs.map(() => `$${++p}`).join(",")})`,
    );
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
         WHERE ${clauses.join(" OR ")}
       )
     ORDER BY ch.detected_at DESC
     LIMIT $1`,
    [limit, ...ids, ...orphanSlugs],
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

export interface CanonicalEntity {
  id: string;
  canonicalKey: string;
  name: string;
  type: string;
  status: string;
  countryCode: string | null;
}

/**
 * slug / canonical_key / alias → canonical entity. Order:
 * gazetteer canonical_key → exact canonical_key (deep links like
 * 'company:alphabet') → `legacy:` unresolved entity → normalized alias
 * (single match only — an ambiguous alias resolves to nothing instead
 * of guessing). NULL when nothing resolves: callers fall back to
 * slug-based junction reads.
 */
export async function resolveEntityRef(
  ref: string,
): Promise<CanonicalEntity | null> {
  const pool = getPool();
  const keys = [
    canonicalEntity(ref)?.key,
    ref.includes(":") ? ref : null,
    `legacy:${ref}`,
  ].filter((k): k is string => !!k);
  for (const key of keys) {
    const { rows } = await pool.query<{
      id: string;
      canonical_key: string;
      canonical_name: string;
      entity_type: string;
      status: string;
      country_code: string | null;
    }>(
      `SELECT id, canonical_key, canonical_name, entity_type, status,
              country_code
       FROM entities WHERE canonical_key = $1`,
      [key],
    );
    if (rows[0]) return canonicalRow(rows[0]);
  }
  const aliasR = await pool.query<{ entity_id: string }>(
    `SELECT DISTINCT entity_id FROM entity_aliases
     WHERE normalized_alias = $1`,
    [normalizeText(ref)],
  );
  if (aliasR.rows.length === 1) {
    const { rows } = await pool.query<{
      id: string;
      canonical_key: string;
      canonical_name: string;
      entity_type: string;
      status: string;
      country_code: string | null;
    }>(
      `SELECT id, canonical_key, canonical_name, entity_type, status,
              country_code FROM entities WHERE id = $1`,
      [aliasR.rows[0].entity_id],
    );
    if (rows[0]) return canonicalRow(rows[0]);
  }
  return null;
}

function canonicalRow(r: {
  id: string;
  canonical_key: string;
  canonical_name: string;
  entity_type: string;
  status: string;
  country_code: string | null;
}): CanonicalEntity {
  return {
    id: r.id,
    canonicalKey: r.canonical_key,
    name: r.canonical_name,
    type: r.entity_type,
    status: r.status,
    countryCode: r.country_code,
  };
}

/** Every live event carrying a canonical entity slug — the entity-page
 *  read behind "theo dõi Fed": junction rows, newest activity first. */
export async function getEntityEvents(slug: string): Promise<{
  slug: string;
  label: string;
  kind: EntityKind | null;
  /** resolved canonical identity — null only when the slug exists
   *  nowhere (pre-migration data and unknown keys alike fall back to
   *  the legacy label path) */
  entity: CanonicalEntity | null;
  aliases: { alias: string; type: string; language: string | null }[];
  identifiers: { scheme: string; value: string; issuer: string | null }[];
  /** Financial Instrument Master rows issued BY this entity.
   *  Instruments are never entities — this is an issuer→instrument
   *  projection, empty for non-issuers (brands, people, places). */
  financialInstruments: EntityInstrument[];
  relationships: {
    type: string;
    direction: "out" | "in";
    other: { canonicalKey: string; name: string; entityType: string };
  }[];
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
  /** two different kinds of "related" — never conflated:
   *    explicit: asserted entity_relationships edges (curated/graph facts)
   *    coOccurrence: junction co-mentions on the same events — NOT a
   *    claimed relationship between the entities */
  related: {
    explicit: {
      canonicalKey: string;
      name: string;
      entityType: string;
      /** gazetteer slug when the counterpart has one — the page links
       *  through it since slug URLs are the proven route; null for
       *  identity-only entities (brands, extras) which render as text */
      gazetteerSlug: string | null;
      relationship: string;
      direction: "out" | "in";
    }[];
    coOccurrence: {
      slug: string;
      canonicalKey: string | null;
      label: string;
      kind: EntityKind | null;
      shared: number;
    }[];
  };
}> {
  const pool = getPool();
  const entity = await resolveEntityRef(slug);
  // canonical id is the read key when resolved; entity_slug stays as
  // the compatibility clause for un-migrated or junction-only slugs
  const whereEntity = entity
    ? `(ee.entity_id = $1 OR ee.entity_slug = $2)`
    : `ee.entity_slug = $2`;
  const params = entity ? [entity.id, slug] : [slug];

  const relatedQ = pool.query<{
    entity_slug: string;
    canonical_key: string | null;
    canonical_name: string | null;
    shared: string;
  }>(
    `SELECT min(ee2.entity_slug) AS entity_slug,
            en.canonical_key, en.canonical_name, count(*) AS shared
     FROM event_entities ee1
     JOIN event_entities ee2
       ON ee2.event_id = ee1.event_id
       AND ${entity ? `(ee2.entity_slug <> $2 AND (ee2.entity_id IS NULL OR ee2.entity_id <> $1))` : `ee2.entity_slug <> $1`}
     LEFT JOIN entities en ON en.id = ee2.entity_id
     JOIN events e ON e.id = ee2.event_id
     WHERE ${entity ? `ee1.entity_id = $1` : `ee1.entity_slug = $1`}
       AND e.status NOT IN ('merged', 'archived')
     GROUP BY COALESCE(en.canonical_key, ee2.entity_slug),
              en.canonical_key, en.canonical_name
     ORDER BY shared DESC, COALESCE(en.canonical_key, ee2.entity_slug)
     LIMIT 8`,
    entity ? params : [slug],
  );

  const aliasQ = entity
    ? pool.query<{
        alias: string;
        alias_type: string;
        language: string | null;
      }>(
        `SELECT alias, alias_type, language FROM entity_aliases
         WHERE entity_id = $1
         ORDER BY alias_type, alias`,
        [entity.id],
      )
    : Promise.resolve({
        rows: [] as {
          alias: string;
          alias_type: string;
          language: string | null;
        }[],
      });

  const identQ = entity
    ? pool.query<{ scheme: string; value: string; issuer: string | null }>(
        `SELECT scheme, value, issuer FROM entity_identifiers
         WHERE entity_id = $1 ORDER BY scheme, value`,
        [entity.id],
      )
    : Promise.resolve({
        rows: [] as { scheme: string; value: string; issuer: string | null }[],
      });

  const instrQ = entity
    ? pool.query<{
        id: string;
        canonical_key: string;
        instrument_type: string;
        status: string;
        name: string | null;
        share_class: string | null;
      }>(
        `SELECT fi.id, fi.canonical_key, fi.instrument_type, fi.status,
                iv.name, iv.share_class
           FROM financial_instruments fi
           LEFT JOIN instrument_versions iv ON iv.id = fi.current_version_id
          WHERE fi.issuer_entity_id = $1
          ORDER BY fi.canonical_key`,
        [entity.id],
      )
    : Promise.resolve({
        rows: [] as {
          id: string;
          canonical_key: string;
          instrument_type: string;
          status: string;
          name: string | null;
          share_class: string | null;
        }[],
      });

  const relQ = entity
    ? pool.query<{
        relationship_type: string;
        dir: string;
        o_key: string;
        o_name: string;
        o_type: string;
        o_slug: string | null;
      }>(
        `SELECT relationship_type, dir, o_key, o_name, o_type, o_slug
         FROM (
           SELECT r.relationship_type, 'out' AS dir, r.id,
                  o.canonical_key AS o_key, o.canonical_name AS o_name,
                  o.entity_type AS o_type,
                  o.metadata->>'gazetteerSlug' AS o_slug
           FROM entity_relationships r
           JOIN entities o ON o.id = r.to_entity_id
           WHERE r.from_entity_id = $1
             AND r.valid_to IS NULL
             AND r.id NOT IN (
               SELECT supersedes_relationship_id
               FROM entity_relationships
               WHERE supersedes_relationship_id IS NOT NULL)
           UNION ALL
           SELECT r.relationship_type, 'in' AS dir, r.id,
                  o.canonical_key, o.canonical_name, o.entity_type,
                  o.metadata->>'gazetteerSlug'
           FROM entity_relationships r
           JOIN entities o ON o.id = r.from_entity_id
           WHERE r.to_entity_id = $1
             AND r.valid_to IS NULL
             AND r.id NOT IN (
               SELECT supersedes_relationship_id
               FROM entity_relationships
               WHERE supersedes_relationship_id IS NOT NULL)
         ) rel
         ORDER BY rel.relationship_type, rel.o_key`,
        [entity.id],
      )
    : Promise.resolve({
        rows: [] as {
          relationship_type: string;
          dir: string;
          o_key: string;
          o_name: string;
          o_type: string;
          o_slug: string | null;
        }[],
      });

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
     WHERE ${whereEntity}
       AND e.status NOT IN ('merged', 'archived')
     GROUP BY e.id, ev.title, e.status, e.topic,
              ev.importance_score, e.first_seen_at, e.last_seen_at,
              ee.in_title
     ORDER BY ee.in_title DESC, e.last_seen_at DESC`,
    params,
  );

  const relRows = (await relQ).rows;
  const explicitKeys = new Set(relRows.map((r) => r.o_key));
  const coOccurrence = (await relatedQ).rows
    .map((r) => ({
      slug: r.entity_slug,
      canonicalKey: r.canonical_key,
      label: r.canonical_name ?? entityLabel(r.entity_slug),
      kind: entityKind(r.entity_slug),
      shared: Number(r.shared),
      key: r.canonical_key ?? canonicalEntity(r.entity_slug)?.key ?? null,
    }))
    // an entity already named by an explicit edge doesn't re-appear as
    // a mere co-mention — keeps the two "related" senses disjoint
    .filter((r) => !r.key || !explicitKeys.has(r.key))
    .map(({ slug, canonicalKey, label, kind, shared }) => ({
      slug,
      canonicalKey,
      label,
      kind,
      shared,
    }));

  return {
    slug,
    label: entity?.name ?? entityLabel(slug),
    kind: (entity ? kindOfType(entity.type) : null) ?? entityKind(slug),
    entity,
    aliases: (await aliasQ).rows.map((r) => ({
      alias: r.alias,
      type: r.alias_type,
      language: r.language,
    })),
    identifiers: (await identQ).rows.map((r) => ({
      scheme: r.scheme,
      value: r.value,
      issuer: r.issuer,
    })),
    financialInstruments: await entityInstruments(pool, (await instrQ).rows),
    relationships: relRows.map((r) => ({
      type: r.relationship_type,
      direction: r.dir as "out" | "in",
      other: {
        canonicalKey: r.o_key,
        name: r.o_name,
        entityType: r.o_type,
      },
    })),
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
    related: {
      explicit: relRows.map((r) => ({
        canonicalKey: r.o_key,
        name: r.o_name,
        entityType: r.o_type,
        gazetteerSlug: r.o_slug,
        relationship: r.relationship_type,
        direction: r.dir as "out" | "in",
      })),
      coOccurrence,
    },
  };
}

// ── Financial Instrument Master reads ─────────────────────────────────────
// Instruments live outside `entities` — these read functions project the
// issuer→instrument/listing graph; identity keys are canonical_key / MIC,
// never tickers.

export interface EntityInstrumentListing {
  id: string;
  canonicalKey: string;
  venue: { mic: string; name: string | null };
  ticker: string | null;
  currency: string | null;
  status: string;
  identifiers: { scheme: string; value: string }[];
  /** latest as-traded regular daily bar — null when no market data yet */
  latestMarket?: {
    sessionDate: string;
    close: string;
    volume: string | null;
    currency: string | null;
    provider: string;
  } | null;
}

export interface EntityInstrument {
  id: string;
  canonicalKey: string;
  type: string;
  status: string;
  name: string | null;
  shareClass: string | null;
  identifiers: { scheme: string; value: string; scope: string }[];
  listings: EntityInstrumentListing[];
}

async function entityInstruments(
  pool: Pool,
  instruments: {
    id: string;
    canonical_key: string;
    instrument_type: string;
    status: string;
    name: string | null;
    share_class: string | null;
  }[],
): Promise<EntityInstrument[]> {
  if (!instruments.length) return [];
  const ids = instruments.map((i) => i.id);
  const identQ = pool.query<{
    instrument_id: string;
    scheme: string;
    value: string;
    scope: string;
  }>(
    `SELECT instrument_id, scheme, value, scope
       FROM instrument_identifiers
      WHERE instrument_id = ANY($1)
        AND id NOT IN (
          SELECT supersedes_identifier_id FROM instrument_identifiers
           WHERE supersedes_identifier_id IS NOT NULL)
      ORDER BY scheme`,
    [ids],
  );
  const listQ = pool.query<{
    id: string;
    canonical_key: string;
    instrument_id: string;
    mic: string;
    market_name: string | null;
    ticker: string | null;
    currency: string | null;
    status: string;
  }>(
    `SELECT l.id, l.canonical_key, l.instrument_id,
            v.mic, vv.market_name,
            lv.ticker, lv.currency, l.status
       FROM instrument_listings l
       JOIN trading_venues v ON v.id = l.venue_id
       LEFT JOIN trading_venue_versions vv ON vv.id = v.current_version_id
       LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
      WHERE l.instrument_id = ANY($1)
      ORDER BY l.canonical_key`,
    [ids],
  );
  const lidQ = pool.query<{
    listing_id: string;
    scheme: string;
    value: string;
  }>(
    `SELECT li.listing_id, li.scheme, li.value
       FROM listing_identifiers li
       JOIN instrument_listings l ON l.id = li.listing_id
      WHERE l.instrument_id = ANY($1)
        AND li.id NOT IN (
          SELECT supersedes_identifier_id FROM listing_identifiers
           WHERE supersedes_identifier_id IS NOT NULL)
      ORDER BY li.scheme`,
    [ids],
  );
  const [idents, listings, lidts] = await Promise.all([identQ, listQ, lidQ]);
  const listingById = new Map<
    string,
    EntityInstrumentListing & { instrument_id: string }
  >();
  for (const l of listings.rows)
    listingById.set(l.id, {
      id: l.id,
      canonicalKey: l.canonical_key,
      instrument_id: l.instrument_id,
      venue: { mic: l.mic, name: l.market_name },
      ticker: l.ticker,
      currency: l.currency,
      status: l.status,
      identifiers: [],
    });
  for (const i of lidts.rows)
    listingById
      .get(i.listing_id)
      ?.identifiers.push({ scheme: i.scheme, value: i.value });
  return instruments.map((i) => ({
    id: i.id,
    canonicalKey: i.canonical_key,
    type: i.instrument_type,
    status: i.status,
    name: i.name,
    shareClass: i.share_class,
    identifiers: idents.rows
      .filter((d) => d.instrument_id === i.id)
      .map((d) => ({ scheme: d.scheme, value: d.value, scope: d.scope })),
    listings: [...listingById.values()]
      .filter((l) => l.instrument_id === i.id)
      .map(({ instrument_id: _omit, ...l }) => l),
  }));
}

/** Entity index — every canonical entity with its graph degree
 *  (macro series + instruments), data-bearing entities first. */
export interface EntityListRow {
  id: string;
  canonicalKey: string;
  name: string;
  type: string;
  macroCount: number;
  instrumentCount: number;
}

export async function getEntityList(): Promise<EntityListRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT e.id, e.canonical_key, e.canonical_name, e.entity_type,
            COALESCE(ms.n, 0) AS macro_n, COALESCE(fi.n, 0) AS instr_n
       FROM entities e
       LEFT JOIN (
         SELECT entity_id, count(*) AS n FROM macro_series GROUP BY entity_id
       ) ms ON ms.entity_id = e.id
       LEFT JOIN (
         SELECT issuer_entity_id, count(*) AS n
           FROM financial_instruments GROUP BY issuer_entity_id
       ) fi ON fi.issuer_entity_id = e.id
      WHERE e.status = 'active'
      ORDER BY (COALESCE(ms.n,0) + COALESCE(fi.n,0)) DESC,
               e.entity_type, e.canonical_key`,
  );
  return rows.map((r) => ({
    id: r.id,
    canonicalKey: r.canonical_key,
    name: r.canonical_name,
    type: r.entity_type,
    macroCount: Number(r.macro_n),
    instrumentCount: Number(r.instr_n),
  }));
}

/** All canonical instruments for the /instrument index — identity +
 *  issuer + latest market quote per instrument (no price advice). */
export interface InstrumentListRow {
  id: string;
  canonicalKey: string;
  type: string;
  name: string | null;
  currency: string | null;
  issuerKey: string | null;
  issuerName: string | null;
  ticker: string | null;
  venueMic: string | null;
  close: string | null;
  closeDate: string | null;
}

export async function getInstrumentList(): Promise<InstrumentListRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT fi.id, fi.canonical_key, fi.instrument_type, fi.status,
            iv.name, iv.currency,
            e.canonical_key AS issuer_key, e.canonical_name AS issuer_name,
            lv.ticker, v.mic AS venue_mic,
            mp.close, mp.session_date AS close_date
       FROM financial_instruments fi
       LEFT JOIN instrument_versions iv ON iv.id = fi.current_version_id
       LEFT JOIN entities e ON e.id = fi.issuer_entity_id
       LEFT JOIN instrument_listings l ON l.instrument_id = fi.id
       LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
       LEFT JOIN trading_venues v ON v.id = l.venue_id
       LEFT JOIN (
         SELECT DISTINCT ON (ms.listing_id)
                ms.listing_id, mv.close, mp2.session_date
           FROM market_points mp2
           JOIN market_point_versions mv ON mv.id = mp2.current_version_id
           JOIN market_series ms ON ms.id = mp2.series_id
          WHERE ms.price_basis = 'as_traded'
          ORDER BY ms.listing_id, mp2.session_date DESC
       ) mp ON mp.listing_id = l.id
      ORDER BY fi.canonical_key`,
  );
  return rows.map((r) => ({
    id: r.id,
    canonicalKey: r.canonical_key,
    type: r.instrument_type,
    name: r.name,
    currency: r.currency,
    issuerKey: r.issuer_key,
    issuerName: r.issuer_name,
    ticker: r.ticker,
    venueMic: r.venue_mic,
    close: r.close != null ? String(r.close) : null,
    closeDate: r.close_date
      ? r.close_date instanceof Date
        ? `${r.close_date.getFullYear()}-${String(r.close_date.getMonth() + 1).padStart(2, "0")}-${String(r.close_date.getDate()).padStart(2, "0")}`
        : String(r.close_date).slice(0, 10)
      : null,
  }));
}

/** Canonical instrument lookup — /api/instruments/<key>.
 *  Returns instrument + issuer + identifiers + listings + observation
 *  provenance chain. No prices, no recommendations. */
export async function getInstrumentView(canonicalKey: string): Promise<{
  instrument: {
    id: string;
    canonicalKey: string;
    type: string;
    status: string;
    name: string | null;
    shortName: string | null;
    assetClass: string | null;
    shareClass: string | null;
    votingClass: string | null;
    currency: string | null;
  };
  issuer: { canonicalKey: string; name: string; entityType: string } | null;
  identifiers: {
    scheme: string;
    value: string;
    scope: string;
    provider: string;
    observationId: string | null;
  }[];
  listings: (EntityInstrumentListing & {
    identifiers: { scheme: string; value: string; provider: string }[];
    latestMarket: {
      sessionDate: string;
      close: string;
      volume: string | null;
      currency: string | null;
      provider: string;
    } | null;
  })[];
  versionCount: number;
  /** Derivation provenance — which registry observations justify this
   *  master record (SEC discovers, OpenFIGI asserts, ISO references the
   *  venue). Observation ids resolve to reference_observations; payloads
   *  stay internal. */
  provenance: {
    subjectType: string;
    subjectId: string;
    role: string;
    observationId: string;
    provider: string;
    dataset: string;
    recordKey: string;
    observedAt: string | null;
    retrievedAt: string;
  }[];
} | null> {
  const pool = getPool();
  const ins = await pool.query<{
    id: string;
    canonical_key: string;
    instrument_type: string;
    status: string;
    issuer_entity_id: string | null;
    name: string | null;
    short_name: string | null;
    asset_class: string | null;
    share_class: string | null;
    voting_class: string | null;
    currency: string | null;
  }>(
    `SELECT fi.id, fi.canonical_key, fi.instrument_type, fi.status,
            fi.issuer_entity_id,
            iv.name, iv.short_name, iv.asset_class, iv.share_class,
            iv.voting_class, iv.currency
       FROM financial_instruments fi
       LEFT JOIN instrument_versions iv ON iv.id = fi.current_version_id
      WHERE fi.canonical_key = $1`,
    [canonicalKey],
  );
  const i = ins.rows[0];
  if (!i) return null;

  const issuerQ = i.issuer_entity_id
    ? pool.query<{
        canonical_key: string;
        canonical_name: string;
        entity_type: string;
      }>(
        `SELECT canonical_key, canonical_name, entity_type FROM entities WHERE id=$1`,
        [i.issuer_entity_id],
      )
    : null;
  const identQ = pool.query(
    `SELECT ii.scheme, ii.value, ii.scope, ii.provider, ii.observation_id
       FROM instrument_identifiers ii
      WHERE ii.instrument_id=$1
        AND ii.id NOT IN (
          SELECT supersedes_identifier_id FROM instrument_identifiers
           WHERE supersedes_identifier_id IS NOT NULL)
      ORDER BY ii.scheme`,
    [i.id],
  );
  const versionsQ = pool.query<{ n: string }>(
    `SELECT count(*) n FROM instrument_versions WHERE instrument_id=$1`,
    [i.id],
  );
  const listQ = pool.query<{
    id: string;
    canonical_key: string;
    mic: string;
    market_name: string | null;
    ticker: string | null;
    currency: string | null;
    status: string;
  }>(
    `SELECT l.id, l.canonical_key, v.mic, vv.market_name,
            lv.ticker, lv.currency, l.status
       FROM instrument_listings l
       JOIN trading_venues v ON v.id = l.venue_id
       LEFT JOIN trading_venue_versions vv ON vv.id = v.current_version_id
       LEFT JOIN listing_versions lv ON lv.id = l.current_version_id
      WHERE l.instrument_id=$1 ORDER BY l.canonical_key`,
    [i.id],
  );
  const lidQ = pool.query(
    `SELECT li.listing_id, li.scheme, li.value, li.provider
       FROM listing_identifiers li
       JOIN instrument_listings l ON l.id = li.listing_id
      WHERE l.instrument_id=$1
        AND li.id NOT IN (
          SELECT supersedes_identifier_id FROM listing_identifiers
           WHERE supersedes_identifier_id IS NOT NULL)
      ORDER BY li.scheme`,
    [i.id],
  );
  const provQ = pool.query<{
    subject_type: string;
    subject_id: string;
    role: string;
    observation_id: string;
    provider: string;
    dataset: string;
    record_key: string;
    observed_at: string | null;
    retrieved_at: string;
  }>(
    `SELECT d.subject_type,
            coalesce(d.instrument_id, d.instrument_version_id,
                     d.listing_id, d.listing_version_id,
                     d.venue_id, d.venue_version_id,
                     d.instrument_identifier_id,
                     d.listing_identifier_id)::text AS subject_id,
            d.role, d.observation_id,
            ro.provider, ro.dataset, ro.record_key,
            ro.observed_at, ro.retrieved_at
       FROM master_derivations d
       JOIN reference_observations ro ON ro.id = d.observation_id
      WHERE d.instrument_id = $1
         OR d.instrument_version_id IN (
              SELECT id FROM instrument_versions WHERE instrument_id = $1)
         OR d.listing_id IN (
              SELECT id FROM instrument_listings WHERE instrument_id = $1)
         OR d.listing_version_id IN (
              SELECT lv.id FROM listing_versions lv
                JOIN instrument_listings l ON l.id = lv.listing_id
               WHERE l.instrument_id = $1)
         OR d.instrument_identifier_id IN (
              SELECT id FROM instrument_identifiers WHERE instrument_id = $1)
         OR d.listing_identifier_id IN (
              SELECT li.id FROM listing_identifiers li
                JOIN instrument_listings l ON l.id = li.listing_id
               WHERE l.instrument_id = $1)
      ORDER BY d.subject_type, ro.provider`,
    [i.id],
  );
  const marketQ = pool.query<{
    listing_id: string;
    session_date: string;
    close: string;
    volume: string | null;
    currency: string | null;
    provider: string;
  }>(
    `SELECT DISTINCT ON (ms.listing_id)
            ms.listing_id, mp.session_date,
            v.close, v.volume, v.currency, ms.provider
       FROM market_series ms
       JOIN market_points mp ON mp.series_id = ms.id
       JOIN market_point_versions v ON v.id = mp.current_version_id
       JOIN instrument_listings l ON l.id = ms.listing_id
      WHERE l.instrument_id = $1
        -- explicit V1 series policy: the alphavantage as-traded series —
        -- never "whatever provider happens to exist"
        AND ms.provider = 'alphavantage' AND ms.dataset = 'time_series_daily'
        AND ms."interval" = '1d' AND ms.session_type = 'regular'
        AND ms.price_basis = 'as_traded'
      ORDER BY ms.listing_id, mp.session_date DESC`,
    [i.id],
  );
  const [issuer, idents, versions, listings, lids, prov, market] =
    await Promise.all([
      issuerQ,
      identQ,
      versionsQ,
      listQ,
      lidQ,
      provQ,
      marketQ,
    ]);
  const latestByListing = new Map(market.rows.map((m) => [m.listing_id, m]));
  const lidByListing = new Map<
    string,
    { scheme: string; value: string; provider: string }[]
  >();
  for (const r of lids.rows) {
    const a = lidByListing.get(r.listing_id) ?? [];
    a.push({ scheme: r.scheme, value: r.value, provider: r.provider });
    lidByListing.set(r.listing_id, a);
  }
  return {
    instrument: {
      id: i.id,
      canonicalKey: i.canonical_key,
      type: i.instrument_type,
      status: i.status,
      name: i.name,
      shortName: i.short_name,
      assetClass: i.asset_class,
      shareClass: i.share_class,
      votingClass: i.voting_class,
      currency: i.currency,
    },
    issuer: issuer
      ? {
          canonicalKey: issuer.rows[0]?.canonical_key ?? "",
          name: issuer.rows[0]?.canonical_name ?? "",
          entityType: issuer.rows[0]?.entity_type ?? "",
        }
      : null,
    identifiers: idents.rows.map((r) => ({
      scheme: r.scheme,
      value: r.value,
      scope: r.scope,
      provider: r.provider,
      observationId: r.observation_id,
    })),
    listings: listings.rows.map((l) => {
      const m = latestByListing.get(l.id);
      return {
        id: l.id,
        canonicalKey: l.canonical_key,
        venue: { mic: l.mic, name: l.market_name },
        ticker: l.ticker,
        currency: l.currency,
        status: l.status,
        identifiers: lidByListing.get(l.id) ?? [],
        // latest as-traded regular daily bar, or null — never fabricated
        latestMarket: m
          ? {
              sessionDate: isoDay(m.session_date),
              close: String(m.close),
              volume: m.volume == null ? null : String(m.volume),
              currency: m.currency,
              provider: m.provider,
            }
          : null,
      };
    }),
    versionCount: Number(versions.rows[0].n),
    provenance: prov.rows.map((r) => ({
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      role: r.role,
      observationId: r.observation_id,
      provider: r.provider,
      dataset: r.dataset,
      recordKey: r.record_key,
      observedAt: r.observed_at,
      retrievedAt: r.retrieved_at,
    })),
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

  // Bounded candidate set: entity-signature match is the dominant signal
  // and runs in SQL (slugs are already normalized ASCII). A pure-token
  // query (no entities) falls back to the SCAN_CAP most recent events —
  // entity_signature/title stay denormalized in JS because PG lacks
  // unaccent for diacritic-insensitive matching.
  const SCAN_CAP = 500;
  const slugs = [...queryEntities];
  // OR'd LIKEs over unnest($1::text[]) — pg-mem doesn't bind array params
  const slugClause = slugs.length
    ? `AND (${slugs
        .map(
          (_, i) =>
            `' ' || e.entity_signature || ' ' LIKE '% ' || $${i + 2} || ' %'`,
        )
        .join(" OR ")})`
    : "";
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
     WHERE (e.status <> 'resolved'
            OR e.last_seen_at > now() - interval '14 days')
       ${slugClause}
     ORDER BY e.last_seen_at DESC
     LIMIT $1`,
    [SCAN_CAP, ...slugs],
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
 *   stableRate    = claims not currently disputed/corrected / assertions
 *   confirmRate   = claims now 'confirmed' / assertions — requires a
 *                   PRIMARY voter, so it's a bonus term, not the baseline
 *   correctedRate = claims now corrected|retracted / assertions (penalty)
 *   unknownShare  = unresolved provenance / documents — absence of evidence
 *                   (mild penalty: originality already misses those docs)
 *   score = 0.5·originality + 0.3·stableRate + 0.2·confirmRate
 *           − 0.25·correctedRate − 0.1·unknownShare
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
      const stableRate = asserted
        ? (asserted - disputed - corrected) / asserted
        : 0;
      const score = Math.max(
        0,
        Math.min(
          1,
          0.5 * originality +
            0.3 * stableRate +
            0.2 * confirmRate -
            0.25 * correctedRate -
            0.1 * unknownShare,
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

// ── Market Data read model ────────────────────────────────────────────────
// Identity is always instrument_listings.id — a ticker is never accepted as
// lookup identity (only as display/provenance echo).

/** DATE column → 'YYYY-MM-DD'. pg driver returns Date parsed as LOCAL
 *  midnight — toISOString() would shift the day in UTC+N timezones, so the
 *  local getters are used deliberately: the date is a label, not an
 *  instant. pg-mem may hand back the same shape or a bare string. */
export function isoDay(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

export interface MarketSeriesView {
  id: string;
  canonicalKey: string;
  listingId: string;
  provider: string;
  dataset: string;
  interval: string;
  sessionType: string;
  priceBasis: string;
  status: string;
  createdAt: string;
}

export interface MarketBar {
  sessionDate: string; // YYYY-MM-DD
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  currency: string | null;
  versionNo: number;
  provider: string;
  observedAt: string;
  observationId: string | null;
}

export async function getMarketSeriesForListing(
  listingId: string,
): Promise<MarketSeriesView[]> {
  const pool = getPool();
  const r = await pool.query<{
    id: string;
    canonical_key: string;
    listing_id: string;
    provider: string;
    dataset: string;
    interval: string;
    session_type: string;
    price_basis: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id, canonical_key, listing_id, provider, dataset, "interval",
            session_type, price_basis, status, created_at
       FROM market_series
      WHERE listing_id = $1
      ORDER BY provider, dataset`,
    [listingId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    canonicalKey: x.canonical_key,
    listingId: x.listing_id,
    provider: x.provider,
    dataset: x.dataset,
    interval: x.interval,
    sessionType: x.session_type,
    priceBasis: x.price_basis,
    status: x.status,
    createdAt: x.created_at,
  }));
}

export async function getMarketSeries(
  seriesId: string,
): Promise<MarketSeriesView | null> {
  const pool = getPool();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      seriesId,
    );
  const r = await pool.query<{
    id: string;
    canonical_key: string;
    listing_id: string;
    provider: string;
    dataset: string;
    interval: string;
    session_type: string;
    price_basis: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id, canonical_key, listing_id, provider, dataset, "interval",
            session_type, price_basis, status, created_at
       FROM market_series
      WHERE ${isUuid ? "id" : "canonical_key"} = $1`,
    [seriesId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id,
    canonicalKey: x.canonical_key,
    listingId: x.listing_id,
    provider: x.provider,
    dataset: x.dataset,
    interval: x.interval,
    sessionType: x.session_type,
    priceBasis: x.price_basis,
    status: x.status,
    createdAt: x.created_at,
  };
}

/** Canonical primitive: bars for ONE series. Never merges providers — a
 *  listing-level read must pick its series explicitly via
 *  getDailyBarsForListing's provider/dataset/priceBasis selector. */
export async function getDailyBarsForSeries(
  seriesId: string,
  opts: {
    from?: string;
    to?: string;
    limit?: number;
    order?: "asc" | "desc";
  } = {},
): Promise<MarketBar[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 5000);
  const order = opts.order === "asc" ? "ASC" : "DESC";
  const r = await pool.query<{
    session_date: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string | null;
    currency: string | null;
    version_no: number;
    provider: string;
    observed_at: string;
    observation_id: string | null;
  }>(
    `SELECT mp.session_date,
            v.open, v.high, v.low, v.close,
            v.volume, v.currency, v.version_no,
            ms.provider, v.observed_at, v.observation_id
       FROM market_points mp
       JOIN market_series ms ON ms.id = mp.series_id
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE mp.series_id = $1
        AND ($2::date IS NULL OR mp.session_date >= $2::date)
        AND ($3::date IS NULL OR mp.session_date <= $3::date)
      ORDER BY mp.session_date ${order}
      LIMIT ${limit}`,
    [seriesId, opts.from ?? null, opts.to ?? null],
  );
  return r.rows.map((x) => ({
    sessionDate: isoDay(x.session_date),
    open: String(x.open),
    high: String(x.high),
    low: String(x.low),
    close: String(x.close),
    volume: x.volume == null ? null : String(x.volume),
    currency: x.currency,
    versionNo: x.version_no,
    provider: x.provider,
    observedAt: x.observed_at,
    observationId: x.observation_id,
  }));
}

/** Listing-level convenience — series selection is EXPLICIT. Callers pass
 *  the provider/dataset/priceBasis they mean; the default is the V1
 *  Alpha Vantage as-traded contract, spelled out, never inferred from
 *  "there happens to be one provider". Returns the chosen series with its
 *  bars; null when no series matches the selector. */
export async function getDailyBarsForListing(
  listingId: string,
  selector: {
    provider?: string;
    dataset?: string;
    priceBasis?: string;
    from?: string;
    to?: string;
    limit?: number;
    order?: "asc" | "desc";
  } = {},
): Promise<{ series: MarketSeriesView; bars: MarketBar[] } | null> {
  // no selector → any single series answers (a VNDirect-only listing has
  // no alphavantage series to default to); ambiguity still requires the
  // caller to narrow explicitly
  const { provider, dataset, priceBasis } = selector;
  const series = (await getMarketSeriesForListing(listingId)).filter(
    (s) =>
      (provider == null || s.provider === provider) &&
      (dataset == null || s.dataset === dataset) &&
      (priceBasis == null || s.priceBasis === priceBasis) &&
      s.interval === "1d" &&
      s.sessionType === "regular",
  );
  if (series.length !== 1) return null; // 0 or ambiguous → caller must narrow
  return {
    series: series[0],
    bars: await getDailyBarsForSeries(series[0].id, selector),
  };
}

export async function getLatestMarketBar(
  seriesId: string,
): Promise<MarketBar | null> {
  const bars = await getDailyBarsForSeries(seriesId, {
    limit: 1,
    order: "desc",
  });
  return bars[0] ?? null;
}

// ── Corporate Actions (0026) ─────────────────────────────────────────────
// Canonical action + current version + every attached provider assertion +
// derivations. Provider disagreement is NEVER hidden — the agreement block
// names the fields providers diverge on; nothing is averaged.

export interface CaAssertionView {
  id: string;
  provider: string;
  dataset: string;
  providerRecordKey: string;
  actionType: string;
  exDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  cashAmount: string | null;
  currency: string | null;
  splitFrom: string | null;
  splitTo: string | null;
  splitFactor: string | null;
  providerStatus: string | null;
  sourceListingId: string | null;
  observationId: string;
  observedAt: string;
  createdAt: string;
}

export interface CaVersionView {
  id: string;
  versionNo: number;
  exDate: string | null;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  cashAmount: string | null;
  currency: string | null;
  splitFrom: string | null;
  splitTo: string | null;
  splitFactor: string | null;
  status: string;
  observationId: string;
  previousVersionId: string | null;
  createdAt: string;
}

export interface CaDerivationView {
  id: string;
  actionVersionId: string;
  assertionId: string;
  observationId: string;
  role: "asserts" | "corroborates" | "conflicts";
  provider: string;
  dataset: string;
}

export interface CorporateActionView {
  id: string;
  canonicalKey: string;
  instrumentId: string;
  actionType: string;
  status: string;
  currentVersion: CaVersionView | null;
  assertions: CaAssertionView[];
  derivations: CaDerivationView[];
  agreement: {
    state: "agreement" | "divergence" | "single_source";
    providers: string[];
    divergentFields: string[];
  };
}

function caAssertionView(r: Record<string, unknown>): CaAssertionView {
  const d = (v: unknown) => (v == null ? null : isoDay(v));
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(r.id),
    provider: String(r.provider),
    dataset: String(r.dataset),
    providerRecordKey: String(r.provider_record_key),
    actionType: String(r.action_type),
    exDate: isoDay(r.ex_date),
    declarationDate: d(r.declaration_date),
    recordDate: d(r.record_date),
    paymentDate: d(r.payment_date),
    cashAmount: s(r.cash_amount),
    currency: s(r.currency),
    splitFrom: s(r.split_from),
    splitTo: s(r.split_to),
    splitFactor: s(r.split_factor),
    providerStatus: s(r.provider_status),
    sourceListingId: s(r.source_listing_id),
    observationId: String(r.observation_id),
    observedAt: String(r.observed_at),
    createdAt: String(r.created_at),
  };
}

function caVersionView(r: Record<string, unknown>): CaVersionView {
  const d = (v: unknown) => (v == null ? null : isoDay(v));
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(r.id),
    versionNo: Number(r.version_no),
    exDate: d(r.ex_date),
    declarationDate: d(r.declaration_date),
    recordDate: d(r.record_date),
    paymentDate: d(r.payment_date),
    cashAmount: s(r.cash_amount),
    currency: s(r.currency),
    splitFrom: s(r.split_from),
    splitTo: s(r.split_to),
    splitFactor: s(r.split_factor),
    status: String(r.status),
    observationId: String(r.observation_id),
    previousVersionId: s(r.previous_version_id),
    createdAt: String(r.created_at),
  };
}

/** Agreement = no pair of assertions disagrees on a field BOTH assert.
 *  NULL ("provider didn't say") never counts as divergence — an EOD
 *  assertion with only the amount corroborates a richer dedicated-feed
 *  assertion when the amounts match. */
function caAgreement(
  assertions: CaAssertionView[],
): CorporateActionView["agreement"] {
  const providers = [...new Set(assertions.map((a) => a.provider))];
  if (assertions.length <= 1 || providers.length <= 1)
    return { state: "single_source", providers, divergentFields: [] };
  const divergentFields = new Set<string>();
  for (let i = 0; i < assertions.length; i++)
    for (let j = i + 1; j < assertions.length; j++) {
      const a = assertions[i];
      const b = assertions[j];
      if (a.provider === b.provider) continue; // same provider ≠ cross-check
      for (const f of caDivergentFields(a, b)) divergentFields.add(f);
    }
  return divergentFields.size
    ? { state: "divergence", providers, divergentFields: [...divergentFields] }
    : { state: "agreement", providers, divergentFields: [] };
}

/** Batched: 3 queries for ALL actions of one instrument — the per-action
 *  variant would fan out N×3 roundtrips, which hurts over the pooler. */
async function caViewsForActions(
  actions: Record<string, unknown>[],
): Promise<CorporateActionView[]> {
  if (!actions.length) return [];
  const pool = getPool();
  const ids = actions.map((a) => a.id);
  // IN-list over ANY($1) — pg-mem doesn't bind array params into ANY()
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  const [vers, asr, der] = await Promise.all([
    pool.query(
      `SELECT * FROM corporate_action_versions WHERE action_id IN (${ph})
        ORDER BY action_id, version_no`,
      ids,
    ),
    pool.query(
      `SELECT * FROM corporate_action_assertions WHERE action_id IN (${ph})
        ORDER BY action_id, provider, dataset, ex_date`,
      ids,
    ),
    pool.query(
      `SELECT d.*, a.provider, a.dataset
         FROM corporate_action_derivations d
         JOIN corporate_action_assertions a ON a.id = d.assertion_id
        WHERE d.action_id IN (${ph})`,
      ids,
    ),
  ]);
  return actions.map((action) => {
    const id = String(action.id);
    // String-compare: pg-mem hands uuid columns back as objects whose
    // === is reference equality; SQL-side ANY() handled it before.
    const actionVers = vers.rows.filter((v) => String(v.action_id) === id);
    const assertions = asr.rows
      .filter((a) => String(a.action_id) === id)
      .map(caAssertionView);
    const curRow = action.current_version_id
      ? actionVers.find(
          (v) => String(v.id) === String(action.current_version_id),
        )
      : null;
    return {
      id,
      canonicalKey: String(action.canonical_key),
      instrumentId: String(action.instrument_id),
      actionType: String(action.action_type),
      status: String(action.status),
      currentVersion: curRow ? caVersionView(curRow) : null,
      assertions,
      derivations: der.rows
        .filter((d) => String(d.action_id) === id)
        .map((d) => ({
          id: String(d.id),
          actionVersionId: String(d.action_version_id),
          assertionId: String(d.assertion_id),
          observationId: String(d.observation_id),
          role: d.role as CaDerivationView["role"],
          provider: String(d.provider),
          dataset: String(d.dataset),
        })),
      agreement: caAgreement(assertions),
    };
  });
}

const caViewsForAction = (action: Record<string, unknown>) =>
  caViewsForActions([action]).then((v) => v[0]);

/** All canonical actions for an instrument — instrument ref is a uuid or
 *  its canonical_key ('instrument:apple:common_stock'). Never a ticker. */
export async function getCorporateActionsForInstrument(
  instrumentRef: string,
): Promise<CorporateActionView[]> {
  const pool = getPool();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      instrumentRef,
    );
  const r = await pool.query(
    `SELECT * FROM corporate_actions
      WHERE instrument_id = ${isUuid ? "$1" : "(SELECT id FROM financial_instruments WHERE canonical_key=$1)"}
      ORDER BY canonical_key`,
    [instrumentRef],
  );
  return caViewsForActions(r.rows);
}

/** Actions visible through a listing — resolves listing → instrument so a
 *  caller holding listing identity still lands on instrument-level truth. */
export async function getCorporateActionsForListing(
  listingRef: string,
): Promise<CorporateActionView[]> {
  const pool = getPool();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      listingRef,
    );
  const l = await pool.query(
    `SELECT instrument_id FROM instrument_listings
      WHERE ${isUuid ? "id" : "canonical_key"} = $1`,
    [listingRef],
  );
  if (!l.rows.length) return [];
  return getCorporateActionsForInstrument(l.rows[0].instrument_id);
}

/** One action by uuid or canonical_key. */
export async function getCorporateAction(
  actionRef: string,
): Promise<CorporateActionView | null> {
  const pool = getPool();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      actionRef,
    );
  const r = await pool.query(
    `SELECT * FROM corporate_actions WHERE ${isUuid ? "id" : "canonical_key"}=$1`,
    [actionRef],
  );
  if (!r.rows.length) return null;
  return caViewsForAction(r.rows[0]);
}

/* --------------------------- macro indicators ---------------------------- */

export interface MacroSeriesView {
  id: string;
  canonicalKey: string;
  provider: string;
  seriesCode: string;
  title: string | null;
  frequency: string | null;
  units: string | null;
  seasonalAdjustment: string | null;
  entityId: string | null;
  entityKey: string | null;
  points: number;
  latestObsDate: string | null;
  latestValue: string | null;
  latestVintage: string | null;
  /** forecast horizon when obs extend beyond today (IMF WEO out-years) */
  horizonObsDate: string | null;
  horizonValue: string | null;
}

export async function getMacroSeriesList(): Promise<MacroSeriesView[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT s.id, s.canonical_key, s.provider, s.series_code, s.title,
            s.frequency, s.units, s.seasonal_adjustment, s.entity_id,
            e.canonical_key AS entity_key,
            COALESCE(c.points, 0) AS points,
            lp.obs_date AS latest_obs,
            lv.value AS latest_val,
            lv.vintage_date AS latest_vint,
            fp.obs_date AS horizon_obs,
            fv.value AS horizon_val
       FROM macro_series s
       LEFT JOIN entities e ON e.id = s.entity_id
       LEFT JOIN (
         SELECT series_id, count(*) AS points,
                -- headline value is the latest ACTUAL; forecast-period
                -- rows (IMF WEO out-years) land on horizon fields instead
                max(obs_date) FILTER (WHERE obs_date <= CURRENT_DATE)
                  AS latest_obs,
                max(obs_date) AS horizon_obs
           FROM macro_points GROUP BY series_id
       ) c ON c.series_id = s.id
       LEFT JOIN macro_points lp
         ON lp.series_id = s.id AND lp.obs_date = c.latest_obs
       LEFT JOIN macro_point_versions lv ON lv.id = lp.current_version_id
       LEFT JOIN macro_points fp
         ON fp.series_id = s.id AND fp.obs_date = c.horizon_obs
       LEFT JOIN macro_point_versions fv ON fv.id = fp.current_version_id
      WHERE s.status='active'
      ORDER BY s.canonical_key`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    canonicalKey: row.canonical_key,
    provider: row.provider,
    seriesCode: row.series_code,
    title: row.title,
    frequency: row.frequency,
    units: row.units,
    seasonalAdjustment: row.seasonal_adjustment,
    entityId: row.entity_id,
    entityKey: row.entity_key,
    points: Number(row.points),
    latestObsDate: row.latest_obs ? isoDay(row.latest_obs) : null,
    latestValue: row.latest_val,
    latestVintage: row.latest_vint ? isoDay(row.latest_vint) : null,
    horizonObsDate:
      row.horizon_obs && row.horizon_obs > row.latest_obs
        ? isoDay(row.horizon_obs)
        : null,
    horizonValue:
      row.horizon_obs && row.horizon_obs > row.latest_obs
        ? row.horizon_val
        : null,
  }));
}

export interface MacroPointView {
  obsDate: string;
  value: string;
  vintageDate: string;
  versionNo: number;
  observedAt: string;
  observationId: string | null;
}

/** Points for one macro series. `asOf` = ALFRED view: the value that was
 *  official at that vintage date — the revision-aware read. Without it,
 *  returns latest-vintage current values. */
export async function getMacroPoints(
  seriesRef: string,
  opts: {
    from?: string;
    to?: string;
    limit?: number;
    order?: "asc" | "desc";
    asOf?: string;
  } = {},
): Promise<MacroPointView[]> {
  const pool = getPool();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      seriesRef,
    );
  const s = await pool.query(
    `SELECT id FROM macro_series
      WHERE ${isUuid ? "id" : "canonical_key"} = $1`,
    [seriesRef],
  );
  if (!s.rows.length) return [];
  const seriesId = s.rows[0].id as string;
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 10000);
  const order = opts.order === "desc" ? "DESC" : "ASC";
  const params: unknown[] = [seriesId];
  let cond = "";
  if (opts.from) {
    params.push(opts.from);
    cond += ` AND p.obs_date >= $${params.length}`;
  }
  if (opts.to) {
    params.push(opts.to);
    cond += ` AND p.obs_date <= $${params.length}`;
  }
  const asOf = opts.asOf;
  const r = asOf
    ? await pool.query(
        // as-of read: latest version whose vintage_date ≤ asOf
        `SELECT obs_date, value, vintage_date, version_no, observed_at, observation_id
           FROM (
             SELECT DISTINCT ON (p.id)
                    p.obs_date, v.value, v.vintage_date, v.version_no,
                    v.observed_at, v.observation_id
               FROM macro_points p
               JOIN macro_point_versions v
                 ON v.point_id = p.id AND v.vintage_date <= $${params.length + 1}
              WHERE p.series_id=$1 ${cond}
              ORDER BY p.id, v.vintage_date DESC, v.version_no DESC
           ) pick
          ORDER BY obs_date ${order} LIMIT $${params.length + 2}`,
        [...params, asOf, limit],
      )
    : await pool.query(
        `SELECT p.obs_date, v.value, v.vintage_date, v.version_no,
                v.observed_at, v.observation_id
           FROM macro_points p
           JOIN macro_point_versions v ON v.id = p.current_version_id
          WHERE p.series_id=$1 ${cond}
          ORDER BY p.obs_date ${order} LIMIT $${params.length + 1}`,
        [...params, limit],
      );
  return r.rows.map((row) => ({
    obsDate: isoDay(row.obs_date),
    value: row.value,
    vintageDate: isoDay(row.vintage_date),
    versionNo: row.version_no,
    observedAt: row.observed_at,
    observationId: row.observation_id,
  }));
}

/** Full version history for one (series, obs_date) — the revision trail. */
export async function getMacroPointHistory(
  seriesRef: string,
  obsDate: string,
): Promise<MacroPointView[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT p.obs_date, v.value, v.vintage_date, v.version_no,
            v.observed_at, v.observation_id
       FROM macro_points p
       JOIN macro_series s ON s.id = p.series_id
       JOIN macro_point_versions v ON v.point_id = p.id
      WHERE (s.canonical_key=$1 OR s.id::text=$1) AND p.obs_date=$2
      ORDER BY v.version_no`,
    [seriesRef, obsDate],
  );
  return r.rows.map((row) => ({
    obsDate: isoDay(row.obs_date),
    value: row.value,
    vintageDate: isoDay(row.vintage_date),
    versionNo: row.version_no,
    observedAt: row.observed_at,
    observationId: row.observation_id,
  }));
}

export interface MacroSeriesDetail {
  id: string;
  canonicalKey: string;
  provider: string;
  seriesCode: string;
  title: string | null;
  frequency: string | null;
  units: string | null;
  seasonalAdjustment: string | null;
  notes: string | null;
  entityId: string | null;
  entityKey: string | null;
}

/** One series by code or canonical key — detail-page header. */
export async function getMacroSeries(
  ref: string,
): Promise<MacroSeriesDetail | null> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT s.id, s.canonical_key, s.provider, s.series_code, s.title,
            s.frequency,
            s.units, s.seasonal_adjustment, s.entity_id,
            s.metadata->>'notes' AS notes,
            e.canonical_key AS entity_key
       FROM macro_series s
       LEFT JOIN entities e ON e.id = s.entity_id
      WHERE s.series_code=$1 OR s.canonical_key=$1 OR s.id::text=$1`,
    [ref],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    provider: row.provider,
    seriesCode: row.series_code,
    title: row.title,
    frequency: row.frequency,
    units: row.units,
    seasonalAdjustment: row.seasonal_adjustment,
    notes: row.notes,
    entityId: row.entity_id,
    entityKey: row.entity_key,
  };
}

/** Macro series scoped to an entity (country/region/CB) with latest
 *  value — the entity-page "vĩ mô" projection. */
export async function getEntityMacroSeries(
  entityId: string,
): Promise<MacroSeriesView[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT s.id, s.canonical_key, s.provider, s.series_code, s.title,
            s.frequency, s.units, s.seasonal_adjustment, s.entity_id,
            c.points, lp.obs_date AS latest_obs,
            lv.value AS latest_val, lv.vintage_date AS latest_vint,
            fp.obs_date AS horizon_obs, fv.value AS horizon_val
       FROM macro_series s
       LEFT JOIN (
         SELECT series_id, count(*) AS points,
                max(obs_date) FILTER (WHERE obs_date <= CURRENT_DATE)
                  AS latest_obs,
                max(obs_date) AS horizon_obs
           FROM macro_points GROUP BY series_id
       ) c ON c.series_id = s.id
       LEFT JOIN macro_points lp
         ON lp.series_id = s.id AND lp.obs_date = c.latest_obs
       LEFT JOIN macro_point_versions lv ON lv.id = lp.current_version_id
       LEFT JOIN macro_points fp
         ON fp.series_id = s.id AND fp.obs_date = c.horizon_obs
       LEFT JOIN macro_point_versions fv ON fv.id = fp.current_version_id
      WHERE s.status='active' AND s.entity_id=$1
      ORDER BY s.canonical_key`,
    [entityId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    canonicalKey: row.canonical_key,
    provider: row.provider,
    seriesCode: row.series_code,
    title: row.title,
    frequency: row.frequency,
    units: row.units,
    seasonalAdjustment: row.seasonal_adjustment,
    entityId: row.entity_id,
    entityKey: null,
    points: Number(row.points ?? 0),
    latestObsDate: row.latest_obs ? isoDay(row.latest_obs) : null,
    latestValue: row.latest_val,
    latestVintage: row.latest_vint ? isoDay(row.latest_vint) : null,
    horizonObsDate:
      row.horizon_obs && row.horizon_obs > row.latest_obs
        ? isoDay(row.horizon_obs)
        : null,
    horizonValue:
      row.horizon_obs && row.horizon_obs > row.latest_obs
        ? row.horizon_val
        : null,
  }));
}

export interface MacroRevisionView {
  obsDate: string;
  versions: number;
  firstValue: string | null;
  latestValue: string | null;
  firstVintage: string | null;
  latestVintage: string | null;
}

/** Points that were actually REVISED — the append-only model made visible:
 *  "the March number as known in April" vs "…as known in July". */
export async function getMacroRevisions(
  seriesRef: string,
  limit = 50,
): Promise<MacroRevisionView[]> {
  const pool = getPool();
  // phase 1: obs_dates with >1 version (GROUP BY + HAVING — pg-mem safe)
  const d = await pool.query(
    `SELECT p.obs_date, count(v.id) AS versions
       FROM macro_points p
       JOIN macro_series s ON s.id = p.series_id
       JOIN macro_point_versions v ON v.point_id = p.id
      WHERE (s.canonical_key=$1 OR s.series_code=$1 OR s.id::text=$1)
      GROUP BY p.obs_date
     HAVING count(v.id) > 1
      ORDER BY p.obs_date DESC
      LIMIT $2`,
    [seriesRef, Math.min(Math.max(1, limit), 500)],
  );
  if (!d.rows.length) return [];
  const dates = d.rows.map((r) => isoDay(r.obs_date));
  const counts = new Map(
    d.rows.map((r) => [isoDay(r.obs_date), Number(r.versions)]),
  );
  // phase 2: first + latest version per revised point
  const inPh = dates.map((_, i) => `$${i + 2}`).join(",");
  const v = await pool.query(
    `SELECT p.obs_date, v.value, v.vintage_date, v.version_no
       FROM macro_points p
       JOIN macro_series s ON s.id = p.series_id
       JOIN macro_point_versions v ON v.point_id = p.id
      WHERE (s.canonical_key=$1 OR s.series_code=$1 OR s.id::text=$1)
        AND p.obs_date IN (${inPh})
      ORDER BY p.obs_date, v.version_no`,
    [seriesRef, ...dates],
  );
  const byDate = new Map<string, { value: string; vintage: string }[]>();
  for (const row of v.rows) {
    const k = isoDay(row.obs_date);
    byDate.set(k, [
      ...(byDate.get(k) ?? []),
      { value: row.value, vintage: isoDay(row.vintage_date) },
    ]);
  }
  return dates.map((obsDate) => {
    const vs = byDate.get(obsDate) ?? [];
    return {
      obsDate,
      versions: counts.get(obsDate) ?? vs.length,
      firstValue: vs[0]?.value ?? null,
      latestValue: vs[vs.length - 1]?.value ?? null,
      firstVintage: vs[0]?.vintage ?? null,
      latestVintage: vs[vs.length - 1]?.vintage ?? null,
    };
  });
}
