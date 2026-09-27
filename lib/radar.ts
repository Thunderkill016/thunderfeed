/**
 * Radar — the unified change feed. One item model across the three change
 * producers (market deltas, macro deltas, canonical events), one ranking
 * model: magnitude/impact × abnormality × relevance × freshness ×
 * evidence. Detection thresholds live in series metadata; this layer is
 * the relevance/display gate on top of them.
 *
 * Event scoring separates three things that must never be conflated:
 *   IMPACT    — does this event matter? (entity weight, VN proximity,
 *               economic scope, novelty)
 *   EVIDENCE  — how sure are we it happened? (primary sources, claim
 *               support, minus disputes)
 *   COVERAGE  — how many outlets are talking? (shown as metadata; wire
 *               reprints inflate this, not certainty)
 *
 * Pure functions; the page supplies rows and `nowMs`.
 */
import { canonicalEntity, extractEntities } from "./entities";
import { jaccard, titleShingles } from "./enrich";
import {
  foldSearchText,
  matchSignalKeywords,
  signalKeywordsFor,
  watchTargetCovers,
  watchTargetKeywords,
} from "./market";
import type { Topic } from "./model";
import type { DataDeltaView, EventListItem } from "./db/read";
import { emptyWatch, type WatchList } from "./relevance";

export type RadarKind = "market" | "macro" | "ca" | "event";

export interface RadarItem {
  id: string;
  kind: RadarKind;
  /** what changed — delta summary or event headline */
  title: string;
  /** small badge: GIÁ ĐỘT BIẾN / VĨ MÔ / DOANH NGHIỆP / SỰ KIỆN */
  badge: string;
  severity: "high" | "medium" | "low";
  detectedAt: string;
  href: string;
  /** provenance one-liners: legs, source counts, claim counts */
  evidence: string[];
  /** recent events whose titles hit this item's keywords */
  related: { id: string; title: string }[];
  /** watch targets this item matched — shown as the "why you" chip */
  matched: string[];
  /** true when detected after the visitor's previousSeenAt — the
   *  "từ lần xem trước" promise made literal */
  isNew: boolean;
  score: number;
  /** entity signature — used by same-story suppression, not rendered */
  entityKeys?: string[];
}

const HOURS = 3_600_000;
/** freshness half-life — after 36h a change is half as salient */
const FRESH_HALFLIFE_H = 36;

/** freshness 0..1 — true half-life: pow(0.5, h/36) → 0.5 at exactly 36h. */
export function freshnessFactor(ageHours: number): number {
  return Math.pow(0.5, Math.max(0, ageHours) / FRESH_HALFLIFE_H);
}

/** abnormality 0..1 — how far outside the routine this change sits.
 *  For deltas the materiality bucket encodes magnitude-vs-threshold;
 *  for events the lifecycle status encodes novelty. */
export function abnormalityFactor(severity: string, status?: string): number {
  if (status) {
    switch (status) {
      case "emerging":
        return 0.85; // new and unpriced-in
      case "active":
        return 0.7;
      case "stable":
        return 0.45;
      case "resolved":
        /* lifecycle ≠ importance — a just-closed summit is still
         * must-see; it only fades via freshness */
        return 0.55;
      default:
        return 0.5;
    }
  }
  switch (severity) {
    case "high":
      return 1;
    case "medium":
      return 0.6;
    default:
      return 0.3;
  }
}

/* ── watch relevance ──────────────────────────────────────────────────── */

export interface ItemRelevance {
  score: number;
  matched: string[];
}

/** Resolve a delta's instrument to the watch targets covering it, and a
 *  title to the watch targets whose keyword vocab it hits — that second
 *  path is what lets a "Bitcoin falls" headline match a BTC watch. */
export function instrumentMatches(
  title: string,
  instrumentSlug: string | null,
  watch: WatchList,
): string[] {
  const matched: string[] = [];
  for (const target of watch.instruments) {
    if (instrumentSlug && watchTargetCovers(target, instrumentSlug)) {
      matched.push(target);
      continue;
    }
    if (watchTargetKeywords(target).some((kw) => keywordHit(kw, title)))
      matched.push(target);
  }
  return matched;
}

function keywordHit(foldedKw: string, title: string): boolean {
  const folded = foldSearchText(title);
  const escaped = foldedKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(folded);
}

/** Watch relevance — same weight scheme as scoreRelevance(): a watched
 *  target match dominates, topic alone is a weak preference signal.
 *  Entities and instruments share the budget — either kind of hit counts. */
export function itemRelevance(
  itemEntities: string[],
  itemTopic: string | null | undefined,
  matchedInstruments: string[],
  watch: WatchList,
): ItemRelevance {
  const matchedEntities = watch.entities.filter((e) =>
    itemEntities.includes(e),
  );
  const hits = matchedEntities.length + matchedInstruments.length;
  const topicMatch = !!itemTopic && watch.topics.includes(itemTopic as Topic);
  const score = Math.min(
    1,
    hits * 0.35 + (hits > 0 ? 0.25 : 0) + (topicMatch ? 0.15 : 0),
  );
  return {
    score,
    matched: [...matchedInstruments, ...matchedEntities],
  };
}

/* ── event impact / evidence / coverage (R3) ─────────────────────────── */

/** Canonical-type importance of the heaviest entity in an event —
 *  a central bank or state moving outweighs a place being mentioned. */
const ENTITY_TYPE_WEIGHT: Record<string, number> = {
  central_bank: 1,
  multilateral_organization: 0.9,
  government_body: 0.9,
  country: 0.6, // being *mentioned* ≠ moving — geo lift lives in geographicRelevance
  company: 0.65,
  organization: 0.6,
  person: 0.55,
  region: 0.45,
  place: 0.35,
  commodity: 0.7,
  topic: 0.3,
};

export function entityImportance(entities: string[]): number {
  let best = 0;
  for (const slug of entities) {
    const w = ENTITY_TYPE_WEIGHT[canonicalEntity(slug)?.type ?? ""] ?? 0.4;
    if (w > best) best = w;
  }
  return best || 0.25; // entityless headline — low intrinsic impact
}

/** Vietnam proximity — the product's core audience lens. Major-power
 *  dyads (US–China summitry, Fed–oil shocks) move Vietnam's trade/FX/gold
 *  even when no Vietnamese entity is named, so they sit above generic
 *  world news. */
/* Canonical slugs, incl. leaders standing in for their state ("Trump" is
 *  the US signal in this corpus — extractEntities never yields "china"
 *  from a "Mỹ - Trung" headline, only xijinping). */
const MAJOR_POWERS = new Set([
  "us",
  "usa",
  "china",
  "trung_quoc",
  "russia",
  "nga",
  "trump",
  "xijinping",
  "putin",
  "biden",
  "federal_reserve",
]);

export function geographicRelevance(entities: string[], topic: string): number {
  const powers = new Set(entities.filter((e) => MAJOR_POWERS.has(e))).size;
  if (topic === "vietnam" || entities.includes("vietnam")) {
    /* vietnam-topic stories whose only entities are places are local
     *  color (festival, flood, traffic) — domestic but not systemic */
    const institutional = entities.some((e) => {
      const t = canonicalEntity(e)?.type;
      return (
        t === "country" ||
        t === "central_bank" ||
        t === "government_body" ||
        t === "company" ||
        t === "person"
      );
    });
    return institutional ? 1 : 0.75;
  }
  if (powers >= 2) return 0.9; // US–CN / US–RU etc — systemic for VN
  if (powers === 1) return 0.65;
  if (entities.some((e) => canonicalEntity(e)?.type === "place")) return 0.55;
  return 0.55;
}

/** Recurring-segment formats — weather bulletins, daily digests, video
 *  recaps, photo essays. They're published every day regardless of the
 *  world, so their change-novelty is near zero even when clustered. */
const BOILERPLATE_RE =
  /dự báo thời tiết|tin nổi bật ngày|nhật ký asiad|tiêu điểm \d|\[video\]|\[ảnh\]|\[infographic\]|thông tin doanh nghiệp/i;

/** Coverage scale 0..1 — how many outlets carry the story, log-scaled.
 *  This is *event size*, not confidence: 40 outlets covering a summit
 *  means the thing is big, even though wire reprints aren't independent
 *  evidence (that's evidenceStrength's job). */
export function coverageScale(sourceCount: number): number {
  return Math.min(1, Math.log10(1 + sourceCount) / Math.log10(40));
}

/** Economic scope of the topic — markets/macro outrank lifestyle. */
export function economicScope(topic: string): number {
  switch (topic) {
    case "business":
      return 0.95;
    case "vietnam":
      return 0.8;
    case "world":
      return 0.6;
    case "technology":
      return 0.5;
    default:
      return 0.3;
  }
}

/** Prominent entity keys for an event — subject/actor rows from
 *  event_entities (R6c). 'mention' rows (signature-only entities like the
 *  UN in a pager story) never reach impact/geo/relevance/suppression.
 *  Falls back to title extraction until the backfill has run. */
export function prominentEntities(e: {
  title: string;
  entities?: { key: string; role: string; prominence: number }[];
}): string[] {
  const rows = e.entities ?? [];
  /* unenriched rows carry the column defaults (mention, 0.5) — if every
   * row is that exact default the backfill hasn't seen this event yet,
   * so fall back to the title extractor rather than treating all
   * signature entities as prominent */
  const enriched = rows.some(
    (en) => en.role !== "mention" || en.prominence !== 0.5,
  );
  if (enriched) {
    /* subject/actor only — 'mention' rows are signature noise (the UN in
     *  a pager story); an enriched event with zero non-mentions honestly
     *  has no central entity */
    return rows.filter((en) => en.role !== "mention").map((en) => en.key);
  }
  return extractEntities(e.title);
}

/** Evidence strength 0..1 — NOT coverage. Lineage origins and claim
 *  adjudication move it; wire-reprint breadth barely does. */
export function evidenceStrength(e: {
  sourceCount: number;
  /** confirmed lineage roots ('original' relation). Absent → fall back
   *  to capped source breadth (pre-lineage rows) */
  independentOrigins?: number;
  /** roots whose source kind is 'primary' — authority evidence */
  primaryOrigins?: number;
  /** docs whose provenance is unknown/dangling. When they outnumber
   *  confirmed origins, evidence is capped — a feed full of
   *  unverifiable reprints can't reach 'strong' */
  unresolvedOrigins?: number;
  primaryCount?: number;
  claimCount: number;
  supportedCount: number;
  disputedCount: number;
}): number {
  const claimN = Math.max(1, e.claimCount);
  /* supported claims count absolutely — a 200-claim event with 2
   *  supported is stronger than a 30-claim event with 2, not weaker.
   *  Disputes stay a ratio: they measure relative conflict */
  const supportedN = Math.min(1, e.supportedCount / 5);
  const disputedRatio = e.disputedCount / claimN;
  /* independence = confirmed lineage roots; rows predating lineage
   *  classification fall back to source breadth (lower ceiling — raw
   *  counts overstate origins). 5 independent origins is saturated. */
  const indep = e.independentOrigins ?? Math.min(e.sourceCount, 5);
  const prim = (e.primaryOrigins ?? 0) + (e.primaryCount ?? 0);
  let v =
    0.3 + // baseline: the resolver already clustered it into an event
    0.35 * Math.min(1, indep / 5) +
    /* claim depth = extraction substantiveness, not importance — it
     *  stays inside evidence where it belongs, never in impact */
    0.15 * Math.min(1, e.claimCount / 30) +
    0.1 * Math.min(1, prim) +
    0.15 * supportedN -
    0.4 * disputedRatio;
  v = Math.max(0, Math.min(1, v));
  /* unverifiable-majority cap — same direction as confidenceState's
   *  weak label: more unknowns than confirmed origins means the corpus
   *  can't prove independence, so evidence stays moderate at best */
  if ((e.unresolvedOrigins ?? 0) > indep)
    v = Math.min(v, UNRESOLVED_MAJORITY_CAP);
  return v;
}

/** ceiling on evidence when unverified docs outnumber confirmed origins */
const UNRESOLVED_MAJORITY_CAP = 0.5;

/** Final score 0..100. Relevance is an additive term, not a multiplier:
 *  a watch nudges ordering among comparably-sized items but can never
 *  bury a globally material event (the previous ×0.4..1.0 multiplier let
 *  a watched local story outrank a US–China summit 2.5:1 — measured
 *  regression in the radar bench). */
export function radarScore(opts: {
  magnitude: number; // 0..1 impact/size depth
  abnormality: number; // 0..1
  relevance: number; // 0..1 personal watch match
  freshness: number; // 0..1
  evidence: number; // 0..1
}): number {
  const v =
    opts.magnitude * 0.28 +
    opts.abnormality * 0.2 +
    opts.evidence * 0.18 +
    opts.freshness * 0.14 +
    Math.min(1, opts.relevance) * 0.2;
  return Math.round(v * 1000) / 10;
}

// ── item construction ────────────────────────────────────────────────────

const KIND_BADGE: Record<string, string> = {
  market_move: "GIÁ ĐỘT BIẾN",
  premium_shift: "CHÊNH DỊCH",
  volume_spike: "VOL ĐỘT BIẾN",
  macro_release: "VĨ MÔ",
  macro_revision: "VĨ MÔ",
  ca_declared: "DOANH NGHIỆP",
  ca_updated: "DOANH NGHIỆP",
};

function deltaKind(d: DataDeltaView): RadarKind {
  if (d.kind === "macro_release" || d.kind === "macro_revision") return "macro";
  if (d.kind === "ca_declared" || d.kind === "ca_updated") return "ca";
  return "market";
}

function deltaHref(d: DataDeltaView): string {
  if (d.kind.startsWith("macro_") && d.seriesKey)
    return `/macro/${d.seriesKey.split(":").join("/")}`;
  if (d.instrumentKey)
    return `/instrument/${d.instrumentKey.split(":").join("/")}`;
  return "/macro";
}

/** Entity slugs a delta is about — ticker keywords plus whatever the
 *  canonical extractor sees in its summary/instrument slug. */
function deltaEntities(d: DataDeltaView): string[] {
  const set = new Set<string>(extractEntities(d.summary));
  if (d.ticker) for (const k of signalKeywordsFor(d.ticker)) set.add(k);
  if (d.instrumentKey) {
    const slug = d.instrumentKey.split(":")[1] ?? "";
    if (slug) for (const tok of slug.split("_")) set.add(foldSearchText(tok));
    for (const k of extractEntities(slug.replace(/_/g, " "))) set.add(k);
  }
  return [...set];
}

const SIX_SOURCES = 6;

/** Build the ranked feed — one pass over deltas + events, sorted by
 *  score, capped. `previousSeenAtMs` splits items into "mới" vs "vẫn
 *  đáng chú ý"; `nowMs` is explicit so SSR/hydration/tests agree. */
export function buildRadarFeed(
  deltas: DataDeltaView[],
  events: EventListItem[],
  watch: WatchList,
  nowMs: number,
  cap = 12,
  previousSeenAtMs?: number | null,
): RadarItem[] {
  const noWatch = emptyWatch(watch);
  const items: RadarItem[] = [];

  for (const d of deltas) {
    const kind = deltaKind(d);
    const entities = deltaEntities(d);
    const instrSlug = d.instrumentKey?.split(":")[1] ?? null;
    const instr = instrumentMatches(d.summary, instrSlug, watch);
    const rel = itemRelevance(entities, "business", instr, watch);
    const related = d.ticker
      ? events
          .filter((e) => matchSignalKeywords(d.ticker!, e.title))
          .slice(0, 2)
          .map((e) => ({ id: e.id, title: e.title }))
      : [];
    const freshness = freshnessFactor(
      (nowMs - Date.parse(d.detectedAt)) / HOURS,
    );
    /* premium/gap series are Vietnam-systemic signals — their floor sits
     *  above a plain medium move even though the detector only saw a
     *  "medium" threshold breach */
    const systemic =
      d.kind === "premium_shift" || (d.instrumentKey ?? "").includes("gap");
    const magnitude = systemic
      ? Math.max(0.7, d.materiality === "high" ? 1 : 0.65)
      : d.materiality === "high"
        ? 0.9
        : d.materiality === "medium"
          ? 0.65
          : 0.3;
    const score = radarScore({
      magnitude,
      abnormality: abnormalityFactor(d.materiality),
      relevance: noWatch ? 0.5 : rel.score,
      freshness,
      /* a market delta's evidence is its versioned bar; a cross-linked
       * news event adds corroboration, not causation */
      evidence: Math.min(1, 0.5 + related.length * 0.25),
    });
    items.push({
      id: d.id,
      kind,
      title: d.summary,
      badge: KIND_BADGE[d.kind] ?? d.kind.toUpperCase(),
      severity: d.materiality as RadarItem["severity"],
      detectedAt: d.detectedAt,
      href: deltaHref(d),
      evidence: [
        kind === "market" ? "chuỗi giá có phiên bản" : "series vĩ mô",
        ...(related.length ? [`${related.length} sự kiện tin tức`] : []),
      ],
      related,
      matched: rel.matched,
      isNew:
        previousSeenAtMs == null || Date.parse(d.detectedAt) > previousSeenAtMs,
      score,
    });
  }

  for (const e of events) {
    const entities = prominentEntities(e);
    const instr = instrumentMatches(e.title, null, watch);
    const rel = itemRelevance(entities, e.topic, instr, watch);
    const freshness = freshnessFactor(
      (nowMs - Date.parse(e.lastSeenAt)) / HOURS,
    );
    /* IMPACT — importance of the thing itself, not its text volume.
     *  coverageScale belongs here (event size), never in evidence —
     *  and it carries real weight: a 58-outlet summit is a bigger
     *  story than a 3-outlet MoU. */
    const novelty = BOILERPLATE_RE.test(e.title)
      ? 0.15
      : abnormalityFactor("", e.status);
    const impact =
      0.2 * entityImportance(entities) +
      0.2 * geographicRelevance(entities, e.topic) +
      0.1 * economicScope(e.topic) +
      0.1 * novelty +
      0.4 * coverageScale(e.sourceCount);
    const score = radarScore({
      magnitude: impact,
      abnormality: abnormalityFactor("", e.status),
      relevance: noWatch ? 0.5 : rel.score,
      freshness,
      evidence: evidenceStrength(e),
    });
    items.push({
      id: e.id,
      kind: "event",
      title: e.title,
      badge: e.status === "emerging" ? "MỚI NỔI" : "SỰ KIỆN",
      severity:
        e.status === "emerging" || e.status === "active" ? "medium" : "low",
      detectedAt: e.lastSeenAt,
      href: `/event/${e.id}`,
      // coverage is context metadata, not confidence — independent
      // lineage origins are shown separately when they diverge
      evidence: [
        e.independentOrigins > 0 && e.independentOrigins < e.sourceCount
          ? `${e.sourceCount} nguồn · ${e.independentOrigins} độc lập`
          : `${e.sourceCount} nguồn`,
        `${e.claimCount} dữ kiện`,
        ...(e.supportedCount > 0 ? [`${e.supportedCount} được xác nhận`] : []),
        ...(e.primaryOrigins > 0 ? [`${e.primaryOrigins} nguồn gốc`] : []),
        ...(e.disputedCount > 0 ? [`${e.disputedCount} tranh chấp`] : []),
      ],
      related: [],
      matched: rel.matched,
      isNew:
        previousSeenAtMs == null || Date.parse(e.lastSeenAt) > previousSeenAtMs,
      score,
      entityKeys: entities,
    });
  }

  /* Same-story suppression: the resolver legitimately keeps sub-stories
   *  as separate events (summit arrival / truce / red lines), but the
   *  feed shouldn't spend 5 slots on one summit. A kept item shadows
   *  later items sharing ≥2 DISTINCTIVE entities — geo entities (country/
   *  region/place) don't count: "vietnam+us" co-occurs across unrelated
   *  stories, so sharing them is not sharing a story (E037 regression).
   *  Events whose whole signature is countries fall back to headline
   *  shingles — two sub-stories of one summit phrase nearly alike. */
  const GEO_TYPES = new Set(["country", "region", "place"]);
  const distinctive = (keys: string[] | undefined) =>
    (keys ?? []).filter((k) => !GEO_TYPES.has(canonicalEntity(k)?.type ?? ""));
  const titleSh = new Map<string, Set<string>>();
  const kept: RadarItem[] = [];
  for (const item of items.sort((a, b) => b.score - a.score)) {
    if (item.score < 8) break; // display floor — dead weight ends the scan
    const keys = distinctive(item.entityKeys);
    const shadowed = kept.some((k) => {
      const shared = keys.filter((e) => distinctive(k.entityKeys).includes(e));
      if (shared.length >= 2) return true;
      /* headline near-match catches pure-dyad pairs ("Mỹ-Trung đình
       * chiến" vs "Mỹ-Trung gia hạn đình chiến") whose distinctive set
       * is empty — same shingles = same story. Events only: deltas are
       * synthetic strings, never editorial dupes */
      if (k.kind !== "event" || item.kind !== "event") return false;
      const a = titleSh.get(k.id) ?? titleShingles(k.title);
      titleSh.set(k.id, a);
      const b = titleSh.get(item.id) ?? titleShingles(item.title);
      titleSh.set(item.id, b);
      return a.size >= 4 && jaccard(a, b) >= 0.5;
    });
    if (!shadowed) {
      kept.push(item);
      if (kept.length >= cap) break;
    }
  }
  return kept;
}
