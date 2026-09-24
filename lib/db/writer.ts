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
import type { Article, StoryCluster } from "../model";

/* ------------------------------- inputs ---------------------------------- */

export type IngestChannel =
  "rss" | "gdelt" | "hn" | "api" | "crawler" | "manual";

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
}

export interface SourceMeta {
  kind?: "primary" | "publisher" | "community" | "aggregator";
  region?: "vietnam" | "global" | "unknown";
  language?: string;
  country?: string;
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

/**
 * Resolver fingerprint — sorted normalized keywords of the lead headline.
 * Exact-match only in v1; the column exists so the matcher can be swapped to
 * pgvector similarity without a schema change.
 */
export function eventSignature(topic: string, title: string): string {
  const toks = normalizeText(title)
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, 8)
    .sort();
  return `${topic}|${toks.join(" ")}`;
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
    `INSERT INTO sources (name, kind, region, language, country)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET updated_at = sources.updated_at
     RETURNING id`,
    [
      name,
      meta.kind ?? "publisher",
      meta.region ?? "unknown",
      meta.language ?? null,
      meta.country ?? null,
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

async function ingestEvidence(
  client: PoolClient,
  article: Article,
  channel: IngestChannel,
  meta: SourceMeta = {},
): Promise<EvidenceRef> {
  const sourceId = await upsertSource(client, article.source, {
    ...meta,
    language: meta.language ?? article.language,
  });
  const url = canonicalUrl(article.url);
  const now = new Date().toISOString();

  const doc = await client.query<{
    id: string;
    current_version_id: string | null;
  }>(
    `INSERT INTO evidence_documents
       (source_id, canonical_url, document_type, published_at,
        first_seen_at, last_seen_at, discovered_via)
     VALUES ($1, $2, 'article', $3, $4, $4, $5)
     ON CONFLICT (source_id, canonical_url)
     DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
     RETURNING id, current_version_id`,
    [sourceId, url, article.publishedAt || null, now, meta.channel ?? channel],
  );
  const documentId = doc.rows[0].id;
  // the version this new observation supersedes — links the version chain
  const supersedes = doc.rows[0].current_version_id;

  const hash = contentHash(article.title, article.summary);
  const ver = await client.query<{ id: string }>(
    `INSERT INTO evidence_versions
       (document_id, version_no, title, summary, content_hash,
        observed_at, source_updated_at, supersedes_version_id)
     SELECT $1,
            COALESCE(MAX(version_no), 0) + 1,
            $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::uuid
     FROM evidence_versions WHERE document_id = $1
     ON CONFLICT (document_id, content_hash) DO NOTHING
     RETURNING id`,
    [
      documentId,
      article.title,
      article.summary || null,
      hash,
      now,
      article.publishedAt || null,
      supersedes,
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
    title: string;
    summary: string;
    occurredAt?: string | null;
    importance?: number;
  },
): Promise<EventRef> {
  const now = new Date().toISOString();
  const ev = await client.query<{ id: string }>(
    `INSERT INTO events
       (event_type, topic, status, signature,
        first_seen_at, last_seen_at, occurred_at)
     VALUES ($1, $2, 'emerging', $3, $4, $4, $5)
     RETURNING id`,
    [
      args.eventType ?? "other",
      args.topic,
      args.signature,
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

/*
 * Two independent merge paths, either is sufficient:
 *   HEADLINE — signature-token Jaccard ≥ 0.55 (same story, drifted title)
 *   FACTS    — ≥50% of the cluster's claim_keys already asserted on the
 *              event (cross-language reports share facts, not vocabulary:
 *              "20 chuyến bay bị hủy" and "20 flights cancelled" have zero
 *              token overlap but identical claim identity)
 * Deliberately conservative: over-splitting beats wrong-merge — siblings
 * can be merged later, split history cannot be un-split.
 */
const MERGE_JACCARD = 0.55;
const MERGE_CLAIM_OVERLAP = 0.5;

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Match a cluster to a live event. Candidates are events in the same topic
 * inside the resolver window; the merge decision uses signature tokens and
 * claim_key overlap. (pgvector embedding widens the candidate pool in P1 —
 * the scoring columns already isolate this swap.)
 */
async function resolveEvent(
  client: PoolClient,
  cluster: StoryCluster,
  claimKeys: string[],
): Promise<EventRef> {
  const signature = eventSignature(cluster.topic, cluster.title);
  const sigTokens = new Set(
    (signature.split("|")[1] ?? "").split(" ").filter(Boolean),
  );

  const cands = await client.query<{
    id: string;
    signature: string;
    current_version_id: string;
  }>(
    `SELECT id, signature, current_version_id FROM events
     WHERE status NOT IN ('merged', 'archived')
       AND topic = $1
       AND last_seen_at > now() - interval '${RESOLVE_WINDOW}'`,
    [cluster.topic],
  );

  let best: (typeof cands.rows)[number] | null = null;
  let bestScore = 0;
  for (const c of cands.rows) {
    const cTokens = new Set(
      (c.signature.split("|")[1] ?? "").split(" ").filter(Boolean),
    );
    const sigSim = jaccard(sigTokens, cTokens);

    let claimOverlap = 0;
    if (claimKeys.length > 0) {
      const ck = await client.query<{ claim_key: string }>(
        `SELECT claim_key FROM claims WHERE event_id = $1`,
        [c.id],
      );
      const shared = ck.rows.filter((r) =>
        claimKeys.includes(r.claim_key),
      ).length;
      claimOverlap = shared / claimKeys.length;
    }

    const score = Math.max(
      sigSim >= MERGE_JACCARD ? sigSim : 0,
      claimKeys.length > 0 && claimOverlap >= MERGE_CLAIM_OVERLAP
        ? claimOverlap
        : 0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (best && bestScore > 0) {
    await client.query(`UPDATE events SET last_seen_at = now() WHERE id = $1`, [
      best.id,
    ]);
    return {
      eventId: best.id,
      eventVersionId: best.current_version_id,
      created: false,
    };
  }
  return createEvent(client, {
    topic: cluster.topic,
    signature,
    title: cluster.title,
    summary: cluster.summary,
    occurredAt: cluster.publishedAt,
    importance: cluster.significanceScore,
  });
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

async function emitChange(
  client: PoolClient,
  eventId: string,
  args: {
    type: string;
    summary: string;
    claimId?: string;
    fromClaimVersionId?: string;
    toClaimVersionId?: string;
    /** event_version change_reason — required for material changes */
    reason?: string;
    /** false → no new event_version (e.g. coverage); the change annotates the current one */
    material?: boolean;
  },
): Promise<void> {
  const cur = await client.query<{ current_version_id: string }>(
    `SELECT current_version_id FROM events WHERE id = $1`,
    [eventId],
  );
  const fromVer = cur.rows[0].current_version_id;
  const material = args.material !== false;
  const toVer = material
    ? await newEventVersion(client, eventId, args.reason ?? "manual")
    : fromVer;
  await client.query(
    `INSERT INTO changes
       (event_id, claim_id, from_event_version_id, to_event_version_id,
        from_claim_version_id, to_claim_version_id,
        type, materiality, summary, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      eventId,
      args.claimId ?? null,
      material ? fromVer : null,
      toVer,
      args.fromClaimVersionId ?? null,
      args.toClaimVersionId ?? null,
      args.type,
      CHANGE_MATERIALITY[args.type] ?? "low",
      args.summary,
    ],
  );
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
 * Upsert one extracted claim and diff it against the current truth-state.
 * The change type depends on WHO asserts:
 *   primary source + same value  → confirmed   (authority corroborates)
 *   primary source + new value   → value_changed (authority revises)
 *   previous asserter + new value → corrected  (a source fixes its own claim)
 *   new outlet + new value        → disputed   (independent sources disagree)
 *   explicit state                → honored (retracted/corrected/… from extractors)
 */
async function upsertClaim(
  client: PoolClient,
  eventId: string,
  claim: ExtractedClaim,
  isPrimary = false,
): Promise<ClaimOutcome> {
  const now = new Date().toISOString();
  const valueJson = JSON.stringify(claim.value);
  const state = claim.state ?? "reported";

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
  const sameValue = JSON.stringify(cur.value) === valueJson;
  const upgradeable = cur.state === "reported" || cur.state === "supported";
  await client.query(`UPDATE claims SET last_seen_at = $1 WHERE id = $2`, [
    now,
    cur.id,
  ]);
  // no-op only when nothing can change — a primary source re-asserting an
  // unconfirmed value is a confirmation, not a no-op
  if (
    sameValue &&
    cur.state === state &&
    !(isPrimary && upgradeable && !claim.state)
  ) {
    return {
      claimId: cur.id,
      claimVersionId: cur.current_version_id,
      change: null,
    };
  }

  let newState: string;
  let changeType: string;
  const explicit = claim.state ? mapState(claim.state) : null;
  if (sameValue) {
    if (explicit) {
      newState = state;
      changeType = explicit;
    } else if (isPrimary && upgradeable) {
      newState = "confirmed";
      changeType = "confirmed";
    } else {
      return {
        claimId: cur.id,
        claimVersionId: cur.current_version_id,
        change: null,
      };
    }
  } else if (explicit) {
    newState = state;
    changeType = explicit;
  } else if (isPrimary) {
    newState = state;
    changeType = "value_changed";
  } else {
    const asserters = await client.query<{ name: string }>(
      `SELECT DISTINCT s.name
       FROM claim_evidence ce
       JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
       JOIN evidence_documents d ON d.id = ev.document_id
       JOIN sources s ON s.id = d.source_id
       WHERE ce.claim_version_id = $1`,
      [cur.current_version_id],
    );
    if (asserters.rows.some((r) => r.name === claim.assertedBy)) {
      newState = "corrected";
      changeType = "corrected";
    } else {
      newState = "disputed";
      changeType = "disputed";
    }
  }

  const cv = await client.query<{ id: string }>(
    `INSERT INTO claim_versions
       (claim_id, version_no, value_type, value, unit, qualifiers, state,
        valid_from, observed_at, previous_version_id, change_type, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      cur.id,
      cur.version_no + 1,
      claim.valueType ?? "text",
      valueJson,
      claim.unit ?? null,
      claim.qualifiers ? JSON.stringify(claim.qualifiers) : null,
      newState,
      claim.validFrom ?? null,
      now,
      cur.current_version_id,
      changeType,
      contentHash(claim.claimKey, valueJson + newState),
    ],
  );
  const claimVersionId = cv.rows[0].id;
  await client.query(
    `UPDATE claims SET current_version_id = $1, last_seen_at = $2 WHERE id = $3`,
    [claimVersionId, now, cur.id],
  );

  const summary = sameValue
    ? `${claim.label} — ${cur.state} → ${newState}`
    : `${claim.label} — ${fmtClaimValue(cur.value)} → ${fmtClaimValue(claim.value)}`;
  return {
    claimId: cur.id,
    claimVersionId,
    fromClaimVersionId: cur.current_version_id,
    change: { type: CHANGE_RECORD[changeType] ?? "claim_updated", summary },
  };
}

async function linkClaimEvidence(
  client: PoolClient,
  claimVersionId: string,
  evidenceVersionId: string,
  stance = "supports",
  evidenceStrength = "secondary",
): Promise<void> {
  await client.query(
    `INSERT INTO claim_evidence
       (claim_version_id, evidence_version_id, stance, evidence_strength,
        extraction_method)
     VALUES ($1, $2, $3, $4::evidence_strength, 'model')
     ON CONFLICT (claim_version_id, evidence_version_id) DO NOTHING`,
    [claimVersionId, evidenceVersionId, stance, evidenceStrength],
  );
}

/* ---------------------------- orchestration ------------------------------ */

export interface PersistResult {
  eventId: string;
  created: boolean;
  evidenceAttached: number;
  changes: string[];
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
  } = {},
): Promise<PersistResult> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) every member article becomes an observed evidence version
    const evBySource = new Map<string, string>();
    const primarySources = new Set<string>();
    let leadEvidenceId = "";
    for (const article of cluster.articles) {
      const meta = opts.sourceMeta?.[article.source];
      const ev = await ingestEvidence(
        client,
        article,
        opts.channel ?? "rss",
        meta,
      );
      evBySource.set(article.source, ev.evidenceVersionId);
      if (meta?.kind === "primary") primarySources.add(article.source);
      if (article.id === cluster.leadArticle.id) {
        leadEvidenceId = ev.evidenceVersionId;
      }
    }

    // 2) event identity — claim keys join the merge decision
    const claimKeys = [...new Set(claims.map((c) => c.claimKey))];
    const { eventId, created } = await resolveEvent(client, cluster, claimKeys);

    // 3) membership edges — origin vs. primary_evidence vs. coverage
    const newEvidence: { evId: string; source: string; primary: boolean }[] =
      [];
    let attached = 0;
    for (const [source, evId] of evBySource) {
      const isOrigin = evId === leadEvidenceId && created;
      const primary = primarySources.has(source);
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
        if (!isOrigin) newEvidence.push({ evId, source, primary });
      }
    }

    // 4) claims — diff against the event's current truth-state
    const changes: string[] = [];
    for (const claim of claims) {
      const evId = evBySource.get(claim.assertedBy) ?? leadEvidenceId;
      const assertedByPrimary = primarySources.has(claim.assertedBy);
      const out = await upsertClaim(client, eventId, claim, assertedByPrimary);
      if (evId) {
        // the document's stance describes how it relates to THIS version:
        // a primary source originates, a disputing doc contradicts, a
        // correcting/retracting doc corrects, everything else supports
        const stance =
          out.change?.type === "claim_disputed"
            ? "contradicts"
            : out.change?.type === "claim_corrected" ||
                out.change?.type === "claim_retracted"
              ? "corrects"
              : assertedByPrimary
                ? "originates"
                : "supports";
        await linkClaimEvidence(
          client,
          out.claimVersionId,
          evId,
          stance,
          assertedByPrimary ? "direct" : "secondary",
        );
      }
      if (out.change) {
        changes.push(out.change.summary);
        await emitChange(client, eventId, {
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
      await emitChange(client, eventId, {
        type: "new_primary_source",
        summary,
        reason: "primary_confirmation",
      });
    }
    if (
      changes.length === 0 &&
      !created &&
      newEvidence.some((e) => !e.primary)
    ) {
      const n = newEvidence.filter((e) => !e.primary).length;
      const summary = `+${n} nguồn tường thuật lại cùng dữ kiện`;
      changes.push(summary);
      await emitChange(client, eventId, {
        type: "new_coverage",
        summary,
        material: false,
      });
    }

    await client.query("COMMIT");
    return { eventId, created, evidenceAttached: attached, changes };
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
