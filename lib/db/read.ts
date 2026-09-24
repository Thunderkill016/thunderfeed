/**
 * Read layer — EventView projections for the API.
 * The UI renders this shape only; it never touches the versioned schema and
 * never computes "what changed" itself — changes arrive pre-computed.
 */

import { getPool } from "./pool";
import { extractEntitiesNormalized } from "../entities";
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

export async function getEventView(eventId: string): Promise<EventView | null> {
  const pool = getPool();

  const ev = await pool.query<{
    id: string;
    topic: string;
    status: string;
    first_seen_at: string;
    last_seen_at: string;
    title: string;
    summary: string;
  }>(
    `SELECT e.id, e.topic, e.status, e.first_seen_at, e.last_seen_at,
            v.title, v.summary
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
    claim_version_id: string;
    evidence_count: string;
    primary_evidence_count: string;
  }>(
    `SELECT ce.claim_version_id,
            COUNT(*) AS evidence_count,
            SUM(CASE WHEN ce.evidence_strength = 'direct'
                     THEN 1 ELSE 0 END) AS primary_evidence_count
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id
     WHERE c.event_id = $1
     GROUP BY ce.claim_version_id`,
    [eventId],
  );

  const changesQ = pool.query<{
    type: string;
    materiality: string;
    summary: string;
    detected_at: string;
  }>(
    `SELECT type, materiality, summary, detected_at
     FROM changes WHERE event_id = $1
     ORDER BY detected_at DESC LIMIT 12`,
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
  }>(
    `SELECT c.id AS claim_id, s.name AS source, cv.value, cv.version_no
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

  // latest lineage assertions for this event's documents — IN-list
  // params instead of ANY($1) for pg-mem compatibility
  const docIds = docsR.rows.map((r) => r.doc_id);
  const latestLin = new Map<
    string,
    { parent: string | null; relation: string }
  >();
  if (docIds.length) {
    const linR = await pool.query<{
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
  }

  const counts = new Map(
    claimCountsR.rows.map((r) => [
      r.claim_version_id,
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
      Map<string, { value: unknown; vn: number }>
    >();
    for (const r of positionsR.rows) {
      const per = latest.get(r.claim_id) ?? new Map();
      const cur = per.get(r.source);
      if (!cur || r.version_no > cur.vn)
        per.set(r.source, { value: r.value, vn: r.version_no });
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
    const n = counts.get(r.claim_version_id);
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

  const directEvidenceCount = claims.reduce(
    (n, c) => n + c.primaryEvidenceCount,
    0,
  );
  // resolve each doc's effective root by walking latest parent links —
  // cycle-safe, depth-capped; stored origin_document_id is only a cache
  const DERIVED_RELS = new Set([
    "syndicated",
    "quoted",
    "rewritten",
    "press_release_based",
  ]);
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const a = latestLin.get(cur);
      if (!a || !a.parent || !DERIVED_RELS.has(a.relation)) return cur;
      cur = a.parent;
    }
    return cur;
  };
  const docById = new Map(docsR.rows.map((r) => [r.doc_id, r]));
  const rootIds = new Set(docsR.rows.map((r) => rootOf(r.doc_id)));
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
  const confirmedIndependentOrigins = confirmedSources.size;
  const primaryOrigins = primarySources.size;
  let derivedDocuments = 0;
  let unresolvedOrigins = 0;
  for (const r of docsR.rows) {
    const rel = latestLin.get(r.doc_id)?.relation;
    if (rel && DERIVED_RELS.has(rel)) derivedDocuments++;
    else if (!rel || rel === "unknown") unresolvedOrigins++;
  }
  const rawSourceCount = new Set(docsR.rows.map((r) => r.source_id)).size;
  const state =
    directEvidenceCount >= 1 && confirmedIndependentOrigins >= 2
      ? "strong"
      : claims.length >= 2 || confirmedIndependentOrigins >= 1
        ? "moderate"
        : "weak";

  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    status: event.status,
    topic: event.topic,
    firstSeenAt: event.first_seen_at,
    lastUpdatedAt: event.last_seen_at,
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
      contradictions: Number(contraR.rows[0]?.n ?? 0),
    },
  };
}

/** Feed of material changes across all live events — the "WHAT CHANGED" rail. */
export async function getLatestChanges(
  limit = 30,
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
       AND ch.materiality IN ('medium', 'high')
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
 * Material changes on events whose canonical entity signature intersects
 * the user's watched slugs — the alert layer of the personal-mission loop.
 * `entity_signature` is a space-joined slug list, so a plain IN on the
 * exploded array matches exactly (no substring false positives).
 */
export async function getChangesForEntities(
  entities: string[],
  limit = 30,
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
       AND ch.materiality IN ('medium', 'high')
       AND EXISTS (
         SELECT 1 FROM unnest(string_to_array(e.entity_signature, ' ')) s
         WHERE s IN (${entities.map((_, i) => `$${i + 2}`).join(",")})
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

  const claimsQ = await pool.query<{ event_id: string; c: string }>(
    `SELECT event_id, COUNT(*) AS c FROM claims GROUP BY event_id`,
  );
  const claimCount = new Map(
    claimsQ.rows.map((r) => [r.event_id, Number(r.c)]),
  );

  const srcQ = await pool.query<{ event_id: string; c: string }>(
    `SELECT ee.event_id, COUNT(DISTINCT ed.source_id) AS c
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents ed ON ed.id = ev.document_id
     GROUP BY ee.event_id`,
  );
  const sourceCount = new Map(srcQ.rows.map((r) => [r.event_id, Number(r.c)]));

  const matQ = await pool.query<{
    event_id: string;
    type: string;
    detected_at: string;
  }>(
    `SELECT event_id, type, detected_at FROM changes
     WHERE materiality <> 'low'
     ORDER BY detected_at DESC`,
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
