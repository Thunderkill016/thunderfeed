/**
 * Read layer — EventView projections for the API.
 * The UI renders this shape only; it never touches the versioned schema and
 * never computes "what changed" itself — changes arrive pre-computed.
 */

import { getPool } from "./pool";

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
  evidence: {
    primary: EvidenceView[];
    publishers: EvidenceView[];
    community: EvidenceView[];
  };
  confidence: {
    state: "weak" | "moderate" | "strong";
    directEvidenceCount: number;
    independentOrigins: number;
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

  // Independent origins = distinct content lineages, not outlets:
  // N wire copies of the same text share one content_hash → one origin;
  // genuinely different reporting produces different hashes.
  const originsQ = pool.query<{ n: string }>(
    `SELECT COUNT(DISTINCT ev.content_hash) AS n
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
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
    evidenceR,
    positionsR,
    originsR,
    contraR,
  ] = await Promise.all([
    claimsQ,
    claimCountsQ,
    changesQ,
    evidenceQ,
    positionsQ,
    originsQ,
    contradictionsQ,
  ]);

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
  const independentOrigins = Number(originsR.rows[0]?.n ?? 0);
  const state =
    directEvidenceCount >= 1 && independentOrigins >= 2
      ? "strong"
      : claims.length >= 2 || independentOrigins >= 1
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
    evidence: bucket,
    confidence: {
      state,
      directEvidenceCount,
      independentOrigins,
      contradictions: Number(contraR.rows[0]?.n ?? 0),
    },
  };
}

/** Feed of material changes across all live events — the "WHAT CHANGED" rail. */
export async function getLatestChanges(
  limit = 30,
): Promise<(ChangeView & { eventId: string; eventTitle: string })[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    event_id: string;
    title: string;
    type: string;
    materiality: string;
    summary: string;
    detected_at: string;
  }>(
    `SELECT ch.event_id, ev.title, ch.type, ch.materiality,
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
