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
import { entitySignature } from "./entities";
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
  const raw = normalizeText(title).split(" ").filter(Boolean);
  const toks = raw.filter((t) => t.length >= 3 && !/^\d+$/.test(t)).sort();
  // number tokens ride in a third segment — "46%" is identity evidence
  // across languages even when no lexical token survives translation.
  // bare years are edition noise, not identity
  const nums = raw
    .filter((t) => /^\d{2,3}$/.test(t) && !/^(19|20)\d\d$/.test(t))
    .sort();
  // consecutive-token bigrams capture phrases unigrams lose:
  // "bóng đá nam" is one facet of a story, not three loose words
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    const bg = `${raw[i]}_${raw[i + 1]}`;
    if (bg.length < 7) continue;
    if (BIGRAM_FORMULA.has(raw[i]) && BIGRAM_FORMULA.has(raw[i + 1])) {
      continue;
    }
    // numeric bigrams are dates/editions ("asiad_2026"), not identity
    if (/^\d+$/.test(raw[i]) || /^\d+$/.test(raw[i + 1])) continue;
    // a bigram that is just a place or person name adds nothing over the
    // entity signature — "viet_nam", "trung_quoc", "ong_trump" name beats
    const bgEnts = entitySignature(`${raw[i]} ${raw[i + 1]}`)
      .split(" ")
      .filter(Boolean);
    if (
      bgEnts.length > 0 &&
      bgEnts.every((e) => HUB_ENTITIES.has(e) || PERSON_ENTITIES.has(e))
    ) {
      continue;
    }
    bigrams.push(bg);
  }
  return `${topic}|${toks.join(" ")}|${nums.join(" ")}|${bigrams.sort().join(" ")}`;
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

/*
 * Merge paths — any one is sufficient, all are gated by entity
 * compatibility (a shared generic claim can never join two events that
 * name different places):
 *
 *   HEADLINE    signature-token Jaccard ≥ 0.55 (same story, drifted title)
 *   ENTITY+SIG  entity Jaccard ≥ 0.5 AND signature ≥ 0.15 — paraphrase or
 *               partial translation keeps some tokens and the same places
 *   ENTITY≥2    ≥2 shared entities with Jaccard ≥ 0.6 — cross-language
 *               coverage with ZERO shared tokens ("Triều Tiên phóng tên
 *               lửa…" ⇄ "North Korea fires missile…"): two specific
 *               entities co-occurring twice in the window is one story
 *   DISTINCTIVE ≥50% of the cluster's subject-qualified claim keys already
 *               asserted on the event ("fed|interest_rate" is identity,
 *               even when the value differs — that's a dispute, same event)
 *   GENERIC     ≥50% of the cluster's generic claims match claim_key+VALUE
 *               exactly ("deaths|20" ≠ "deaths|15"), AND corroboration:
 *               shared entity, signature ≥ 0.3, OR — only when every
 *               generic claim is incident-scoped (a fact type bound to
 *               ONE incident, like flights_cancelled) — both sides
 *               simply name no place. Recurring metrics (sentence_years,
 *               victims, money) share values across thousands of cases
 *               and must never self-merge without context.
 *
 * Entity contradiction is a HARD BLOCK on every path. Over-splitting
 * beats wrong-merge: siblings can be merged later, split history
 * cannot be un-split.
 */
const MERGE_JACCARD = 0.55;
const MERGE_CLAIM_OVERLAP = 0.5;
/** signature floor that lets an exact generic-claim match merge */
const GENERIC_SIG_FLOOR = 0.3;
/** signature floor that lets a located pair merge on entity+tokens */
const ENTITY_SIG_FLOOR = 0.2;
/** ≥2 shared entities + Jaccard ≥ 0.6 merges even with no shared tokens */
const ENTITY_STRONG_SHARED = 2;
const ENTITY_STRONG_SIM = 0.6;
/** high-frequency geopolitical actors — sharing ONLY these carries no
 *  event identity ("every second story is US-China"); a hub-only overlap
 *  still needs headline support */
/**
 * geographic entities name a beat, never an event — every VN outlet covers
 * "us + china" daily. only non-geo entities (people, orgs, competitions,
 * companies) may serve as identity evidence.
 */
const HUB_ENTITIES = new Set([
  "us",
  "un",
  "europe",
  "middleeast",
  "baltic",
  "mientrung",
  "mienbac",
  "miennam",
  "taynguyen",
  // countries
  "vietnam",
  "china",
  "japan",
  "southkorea",
  "northkorea",
  "taiwan",
  "hongkong",
  "thailand",
  "myanmar",
  "laos",
  "cambodia",
  "malaysia",
  "singapore",
  "indonesia",
  "philippines",
  "india",
  "pakistan",
  "bangladesh",
  "australia",
  "newzealand",
  "israel",
  "palestine",
  "iran",
  "iraq",
  "syria",
  "lebanon",
  "yemen",
  "saudi",
  "uae",
  "qatar",
  "russia",
  "ukraine",
  "uk",
  "france",
  "germany",
  "italy",
  "spain",
  "poland",
  "netherlands",
  "belgium",
  "switzerland",
  "sweden",
  "norway",
  "denmark",
  "finland",
  "austria",
  "greece",
  "portugal",
  "ireland",
  "hungary",
  "czech",
  "romania",
  "canada",
  "mexico",
  "brazil",
  "argentina",
  "chile",
  "peru",
  "colombia",
  "venezuela",
  "cuba",
  "panama",
  "haiti",
  "egypt",
  "southafrica",
  "nigeria",
  "kenya",
  "sudan",
  "ethiopia",
  "morocco",
  "libya",
  "congo",
  "southsudan",
  // vn cities & provinces
  "hanoi",
  "hcmc",
  "danang",
  "haiphong",
  "cantho",
  "hue",
  "nhatrang",
  "dalat",
  "quangninh",
  "hatinh",
  "nghean",
  "thanhhoa",
  "laocai",
  "langson",
  "caobang",
  "dienbien",
  "sonla",
  "gialai",
  "daklak",
  "angiang",
  "kiengiang",
  "camau",
  "binhduong",
  "dongnai",
  "bariavungtau",
  "bacninh",
  "phuquoc",
  "quangtri",
  "khanhhoa",
  "lamdong",
  "halong",
]);
/** signature floor for entity merges whose shared entities are all hubs */
const HUB_SIG_FLOOR = 0.3;
/** a single shared hub entity needs strong headline support to merge */
const HUB_SINGLE_SIG_FLOOR = 0.4;
/** named individuals anchor an event — a shared person entity plus
 *  modest headline overlap is same-story evidence */
const PERSON_ENTITIES = new Set([
  "trump",
  "putin",
  "zelensky",
  "xijinping",
  "kimjongun",
  "netanyahu",
  "modi",
  "milei",
  "lam",
  "biden",
  "macron",
  "hunsen",
  "kimsangsik",
]);
const PERSON_SIG_FLOOR = 0.2;
/** institutional/civic vocabulary repeats across UNRELATED stories —
 *  it can never be a "rare" identity token */
const RARE_TOKEN_EXCLUDE = new Set([
  "thuong",
  "truc",
  "trung",
  "quoc",
  "viet",
  "dang",
  "chinh",
  "nguoi",
  "cong",
  "giao",
  "thong",
  "duong",
  "benh",
  "vien",
  "truong",
  "sinh",
  "doanh",
  "nghiep",
  "kinh",
  "thanh",
  "tinh",
  "huyen",
  "ngay",
  "sang",
  "chieu",
  "tuan",
  "thang",
  // country/geo names recur across unrelated incidents — they are
  // entities, not identity tokens
  "ukraine",
  "russia",
  "vietnam",
  "trungquoc",
  "asean",
]);
/** a shared uncommon token (storm name, codename) + modest overlap merges */
const RARE_TOKEN_MIN_LEN = 5;
const RARE_SIG_FLOOR = 0.2;
/** schedule/wire formula vocabulary — a bigram made only of these is
 *  boilerplate ("lịch thi đấu"), not event identity */
const BIGRAM_FORMULA = new Set([
  "lich",
  "thi",
  "dau",
  "ngay",
  "gio",
  "truc",
  "tiep",
  "ket",
  "qua",
  "cap",
  "nhat",
  "moi",
  "video",
  "anh",
  "bai",
  "hoi",
  "nghi",
  "tin",
]);
/** numbers that identify an event across languages — years and round
 *  figures are too common to count */
const isDistinctiveNumber = (t: string) =>
  /^\d{2,3}$/.test(t) &&
  !/^(1[0-9]|[2-9]0|25|50|100|200|300|400|500|1000|202\d)$/.test(t);
/** fact types bound to ONE incident — identical value + no location on
 *  either side is legitimate same-event evidence; recurring metrics are not */
const INCIDENT_SCOPED = new Set([
  "deaths",
  "injured",
  "missing",
  "evacuated",
  "flights_cancelled",
  "magnitude",
]);

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

const isDistinctiveKey = (key: string) => key.includes("|");
const genericFingerprint = (c: ExtractedClaim) =>
  `${c.claimKey}|${JSON.stringify(c.value)}`;

/**
 * Match a cluster to a live event. Candidates are events in the same
 * topic inside the resolver window; the merge decision weighs headline
 * tokens, distinctive claim keys, and exact generic-claim values under
 * an entity-compatibility gate.
 */
async function resolveEvent(
  client: PoolClient,
  cluster: StoryCluster,
  claims: ExtractedClaim[],
): Promise<EventRef> {
  const signature = eventSignature(cluster.topic, cluster.title);
  const sigParts = signature.split("|");
  const sigTokens = new Set((sigParts[1] ?? "").split(" ").filter(Boolean));
  const numTokens = new Set((sigParts[2] ?? "").split(" ").filter(Boolean));
  const bigTokens = new Set((sigParts[3] ?? "").split(" ").filter(Boolean));
  const entSig = entitySignature(`${cluster.title} ${cluster.summary}`);
  const entTokens = new Set(entSig.split(" ").filter(Boolean));
  // title-only entities are the identity; summary entities corroborate —
  // wire boilerplate in summaries must not mint event identity
  const entCoreTokens = new Set(
    entitySignature(cluster.title).split(" ").filter(Boolean),
  );

  const distinctiveKeys = new Set(
    claims.map((c) => c.claimKey).filter(isDistinctiveKey),
  );
  const genericFps = new Set(
    claims.filter((c) => !isDistinctiveKey(c.claimKey)).map(genericFingerprint),
  );

  const cands = await client.query<{
    id: string;
    signature: string;
    entity_signature: string;
    entity_signature_core: string;
    current_version_id: string;
  }>(
    `SELECT id, signature, entity_signature, entity_signature_core,
            current_version_id
     FROM events
     WHERE status NOT IN ('merged', 'archived')
       AND last_seen_at > now() - interval '${RESOLVE_WINDOW}'`,
  );

  let best: (typeof cands.rows)[number] | null = null;
  let bestScore = 0;
  for (const c of cands.rows) {
    const cSigParts = c.signature.split("|");
    const cTokens = new Set((cSigParts[1] ?? "").split(" ").filter(Boolean));
    const cNums = new Set((cSigParts[2] ?? "").split(" ").filter(Boolean));
    const cBigs = new Set((cSigParts[3] ?? "").split(" ").filter(Boolean));
    const cEnt = new Set(c.entity_signature.split(" ").filter(Boolean));
    const cCore = new Set(
      (c.entity_signature_core || c.entity_signature)
        .split(" ")
        .filter(Boolean),
    );

    const sigSim = jaccard(sigTokens, cTokens);
    const entSim = jaccard(entTokens, cEnt);
    const coreEntSim = jaccard(entCoreTokens, cCore);
    const coreShared = [...entCoreTokens].filter((e) => cCore.has(e));
    const fullShared = [...entTokens].filter((e) => cEnt.has(e));
    // hub-only entity overlap (us+china, russia+ukraine…) names a beat,
    // not an event — it needs a non-hub entity or real headline support.
    // a lone hub ("vietnam") needs still stronger support.
    const entityEvidence =
      coreShared.some((e) => !HUB_ENTITIES.has(e)) ||
      sigSim >= (coreShared.length >= 2 ? HUB_SIG_FLOOR : HUB_SINGLE_SIG_FLOOR);
    const personShared = coreShared.some((e) => PERSON_ENTITIES.has(e));
    const numShared = [...numTokens].some(
      (t) => cNums.has(t) && isDistinctiveNumber(t),
    );
    // entity contradiction blocks only the paths that USE entities as
    // evidence — a strong independent identity (headline/rare-token/
    // person/distinctive claim) survives differing place mentions:
    // "Biển Đông" and "miền Trung" are one storm's route, not two events.
    const entityBlocked =
      entCoreTokens.size > 0 && cCore.size > 0 && coreShared.length === 0;

    // candidate's claim space: every versioned value (all positions),
    // so a cluster asserting an earlier position still matches
    let distinctiveOverlap = 0;
    let genericOverlap = 0;
    if (claims.length > 0) {
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
      const candKeys = new Set(ck.rows.map((r) => r.claim_key));
      const candFps = new Set(
        ck.rows.map((r) => `${r.claim_key}|${JSON.stringify(r.value)}`),
      );
      if (distinctiveKeys.size > 0) {
        const shared = [...distinctiveKeys].filter((k) =>
          candKeys.has(k),
        ).length;
        distinctiveOverlap = shared / distinctiveKeys.size;
      }
      if (genericFps.size > 0) {
        const shared = [...genericFps].filter((f) => candFps.has(f)).length;
        genericOverlap = shared / genericFps.size;
      }
    }

    const sharedRare = [...sigTokens].filter(
      (t) =>
        cTokens.has(t) &&
        t.length >= RARE_TOKEN_MIN_LEN &&
        !/^\d+$/.test(t) &&
        !RARE_TOKEN_EXCLUDE.has(t),
    ).length;

    // numbers appearing on one side but not the other are an anti-signal
    // for entity-based paths: "8 đội ASIAD 2026" and "lịch đấu 24/9" share
    // the competition but not the sub-event. identity paths (headline,
    // rare token, person, distinctive claim) are exempt.
    const strictNumConflict =
      (numTokens.size > 0 || cNums.size > 0) &&
      ![...numTokens].some((t) => cNums.has(t));
    const crossLingual =
      sigSim < 0.1 &&
      !strictNumConflict &&
      coreShared.some((e) => !HUB_ENTITIES.has(e)) &&
      fullShared.length >= 2 &&
      coreEntSim >= 0.4;

    const eligible =
      sigSim >= MERGE_JACCARD ||
      (sharedRare > 0 && sigSim >= RARE_SIG_FLOOR) ||
      (personShared && sigSim >= PERSON_SIG_FLOOR) ||
      // a shared title phrase plus a real (non-hub) entity is identity —
      // hub-only pairs like "trung_quoc" bigrams name a beat, not an event
      (sigSim >= 0.1 &&
        [...bigTokens].some((b) => cBigs.has(b)) &&
        coreShared.some((e) => !HUB_ENTITIES.has(e))) ||
      (numShared && coreShared.length >= 2) ||
      crossLingual ||
      (distinctiveKeys.size > 0 && distinctiveOverlap >= MERGE_CLAIM_OVERLAP) ||
      (!entityBlocked &&
        (((!strictNumConflict || sigSim >= 0.2) &&
          // a numeric mismatch only vetoes weak-headline entity matches;
          // real token overlap means the numbers are facets, not identity
          ((coreEntSim >= 0.5 &&
            sigSim >= ENTITY_SIG_FLOOR &&
            entityEvidence) ||
            (coreShared.length >= ENTITY_STRONG_SHARED &&
              coreEntSim >= ENTITY_STRONG_SIM &&
              entityEvidence))) ||
          // an exact claim-value fingerprint is identity itself — a stray
          // title number must not veto it
          (genericFps.size > 0 &&
            genericOverlap >= MERGE_CLAIM_OVERLAP &&
            (entSim > 0 ||
              sigSim >= GENERIC_SIG_FLOOR ||
              (entTokens.size === 0 &&
                cEnt.size === 0 &&
                [...genericFps].every((f) =>
                  INCIDENT_SCOPED.has(f.split("|")[0]),
                ))))));

    if (!eligible) continue;
    const score = Math.max(sigSim, entSim, distinctiveOverlap, genericOverlap);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (best) {
    // entity signature accumulates — newly observed places join the event
    const merged = new Set([
      ...entTokens,
      ...best.entity_signature.split(" ").filter(Boolean),
    ]);
    const mergedSig = [...merged].sort().join(" ");
    const mergedCore = new Set([
      ...entCoreTokens,
      ...(best.entity_signature_core || best.entity_signature)
        .split(" ")
        .filter(Boolean),
    ]);
    const mergedCoreSig = [...mergedCore].sort().join(" ");
    await client.query(
      `UPDATE events
       SET last_seen_at = now(), entity_signature = $2,
           entity_signature_core = $3
       WHERE id = $1`,
      [best.id, mergedSig, mergedCoreSig],
    );
    return {
      eventId: best.id,
      eventVersionId: best.current_version_id,
      created: false,
    };
  }
  return createEvent(client, {
    topic: cluster.topic,
    signature,
    entitySignature: entSig,
    entitySignatureCore: [...entCoreTokens].sort().join(" "),
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

    // 1) every member article becomes an observed evidence version.
    // keyed by article (not source) — one source can carry several
    // documents in a cluster and claims must resolve to the right doc
    const evByArticle = new Map<string, string>();
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
      evByArticle.set(article.id, ev.evidenceVersionId);
      evBySource.set(article.source, ev.evidenceVersionId);
      if (meta?.kind === "primary") primarySources.add(article.source);
      if (article.id === cluster.leadArticle.id) {
        leadEvidenceId = ev.evidenceVersionId;
      }
    }

    // 2) event identity — claims join the merge decision (value-aware)
    const { eventId, created } = await resolveEvent(client, cluster, claims);

    // 3) membership edges — one event_evidence row per DOCUMENT
    const newEvidence: { evId: string; source: string; primary: boolean }[] =
      [];
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
          newEvidence.push({ evId, source: article.source, primary });
      }
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
    if (
      pending.length === 0 &&
      !created &&
      newEvidence.some((e) => !e.primary)
    ) {
      const n = newEvidence.filter((e) => !e.primary).length;
      const summary = `+${n} nguồn tường thuật lại cùng dữ kiện`;
      changes.push(summary);
      pending.push({
        type: "new_coverage",
        summary,
        material: false,
      });
    }

    await flushChanges(client, eventId, pending, created);
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
