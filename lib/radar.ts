/**
 * Radar — the unified change feed. One item model across the three change
 * producers (market deltas, macro deltas, canonical events), one ranking
 * model: magnitude × abnormality × relevance × freshness × evidence.
 *
 * Detection thresholds live in series metadata (lib/db/market.ts); this
 * layer is the relevance/display gate — a detected change still has to
 * score well enough to surface. Pure functions; the page supplies rows.
 */
import { extractEntities } from "./entities";
import {
  foldSearchText,
  matchSignalKeywords,
  signalKeywordsFor,
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
  /** small badge: GIÁ ĐỘT BIẾN / VĨ MÔ / DOANH NGHIỆP / topic label */
  badge: string;
  severity: "high" | "medium" | "low";
  detectedAt: string;
  href: string;
  /** provenance one-liners: legs, source counts, claim counts */
  evidence: string[];
  /** recent events whose titles hit this item's keywords */
  related: { id: string; title: string }[];
  /** watch entities this item matched — shown as the "why you" chip */
  matched: string[];
  score: number;
}

const HOURS = 3_600_000;
/** freshness half-life ~36h — a day-old change is background, not news */
const FRESH_DECAY_H = 36;

/** freshness 0..1 — exponential decay anchored to an explicit `now`. */
export function freshnessFactor(ageHours: number): number {
  return Math.exp(-Math.max(0, ageHours) / FRESH_DECAY_H);
}

/** abnormality 0..1 — how far outside the routine this change sits.
 *  materiality buckets encode magnitude-vs-threshold already. */
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
        return 0.25;
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

/** Watch relevance — same weight scheme as scoreRelevance(): entity
 *  matches dominate, topic alone is a weak preference signal. */
export function itemRelevance(
  itemEntities: string[],
  itemTopic: string | null | undefined,
  watch: WatchList,
): { score: number; matched: string[] } {
  const matched = watch.entities.filter((e) => itemEntities.includes(e));
  const topicMatch = !!itemTopic && watch.topics.includes(itemTopic as Topic);
  const score = Math.min(
    1,
    matched.length * 0.35 +
      (matched.length > 0 ? 0.25 : 0) +
      (topicMatch ? 0.15 : 0),
  );
  return { score, matched };
}

/** Final score 0..100. Relevance is the multiplier: nothing a user
 *  watches should sink under noise, nothing unwatched should drown the
 *  feed — unwatched items keep a 0.4 floor, not zero. */
export function radarScore(opts: {
  magnitude: number; // 0..1 corroboration/size depth
  abnormality: number; // 0..1
  relevance: number; // 0..1
  freshness: number; // 0..1
  evidence: number; // 0..1
}): number {
  const base =
    opts.abnormality * 0.4 +
    opts.magnitude * 0.2 +
    opts.evidence * 0.2 +
    opts.freshness * 0.2;
  const rel = opts.relevance <= 0 ? 0.4 : 0.4 + 0.6 * opts.relevance;
  return Math.round(base * rel * 1000) / 10;
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
  if (d.kind.startsWith("ca_") && d.instrumentKey)
    return `/instrument/${d.instrumentKey.split(":").join("/")}`;
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
    // both the folded phrase and its tokens — "vang_sjc_9999" should hit
    // a watch on "vang" alone
    if (slug) for (const tok of slug.split("_")) set.add(foldSearchText(tok));
    for (const k of extractEntities(slug.replace(/_/g, " "))) set.add(k);
  }
  return [...set];
}

function eventEntities(e: EventListItem): string[] {
  return extractEntities(`${e.title}`);
}

const SIX_SOURCES = 6;
const SIX_CLAIMS = 6;

/** Build the ranked feed — one pass over deltas + events, sorted by
 *  score, capped. `nowMs` is explicit so SSR/hydration/tests agree. */
export function buildRadarFeed(
  deltas: DataDeltaView[],
  events: EventListItem[],
  watch: WatchList,
  nowMs: number,
  cap = 12,
): RadarItem[] {
  const noWatch = emptyWatch(watch);
  const items: RadarItem[] = [];

  for (const d of deltas) {
    const kind = deltaKind(d);
    const entities = deltaEntities(d);
    const rel = itemRelevance(entities, "business", watch);
    const related = d.ticker
      ? events
          .filter((e) => signalMatches(d.ticker!, e.title))
          .slice(0, 2)
          .map((e) => ({ id: e.id, title: e.title }))
      : [];
    const freshness = freshnessFactor(
      (nowMs - Date.parse(d.detectedAt)) / HOURS,
    );
    const score = radarScore({
      magnitude:
        d.materiality === "high"
          ? 0.9
          : d.materiality === "medium"
            ? 0.55
            : 0.3,
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
      score,
    });
  }

  for (const e of events) {
    const entities = eventEntities(e);
    const rel = itemRelevance(entities, e.topic, watch);
    const freshness = freshnessFactor(
      (nowMs - Date.parse(e.lastSeenAt)) / HOURS,
    );
    const score = radarScore({
      magnitude: 0.3 + 0.7 * Math.min(1, e.claimCount / SIX_CLAIMS),
      abnormality: abnormalityFactor("", e.status),
      relevance: noWatch ? 0.5 : rel.score,
      freshness,
      evidence: Math.min(1, e.sourceCount / SIX_SOURCES),
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
      evidence: [`${e.sourceCount} nguồn`, `${e.claimCount} dữ kiện`],
      related: [],
      matched: rel.matched,
      score,
    });
  }

  return items
    .sort((a, b) => b.score - a.score)
    .filter((i) => i.score >= 8) // display floor — don't show dead weight
    .slice(0, cap);
}

function signalMatches(ticker: string, title: string): boolean {
  return matchSignalKeywords(ticker, title);
}
