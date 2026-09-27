/**
 * Personal mission relevance — step 8 of the canonical loop.
 * A user's watch list (canonical entity slugs + topics) is scored against
 * canonical cluster state — entities extracted by the same ontology the
 * resolver uses — never against headline heuristics. Pure functions so the
 * ranking is unit-testable and identical on server and client.
 */
import { topics, type StoryCluster, type Topic, type Edition } from "./model";
import { extractEntities } from "./entities";

export interface WatchList {
  /** canonical entity slugs — e.g. "fed", "china", "openai" */
  entities: string[];
  /** instrument watch targets — asset-family keys ("vang", "ty_gia") or
   *  canonical instrument slugs ("bitcoin"). NOT entities: an asset has
   *  series/listings, not a canonical entity row — conflating the two
   *  ontologies breaks news↔market relevance. */
  instruments: string[];
  topics: Topic[];
}

export interface Relevance {
  /** 0..1 — matched entities dominate; topic alone never tops the list. */
  score: number;
  matchedEntities: string[];
  topicMatch: boolean;
}

export function parseWatch(searchParams: URLSearchParams): WatchList {
  const entities = (searchParams.get("e") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    // canonicalize free terms → ontology slugs ("fed" → "federal_reserve");
    // already-canonical slugs pass through unchanged
    .map((s) => extractEntities(s)[0] ?? s);
  const instruments = (searchParams.get("i") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const topics = (searchParams.get("t") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Topic[];
  return { entities, instruments, topics };
}

/** Cookie twin of parseWatch — the client mirrors localStorage into
 *  `tf_watch` so SSR can score relevance before hydration. Malformed
 *  input degrades to an empty watch, never an error. */
export function watchFromCookie(raw: string | undefined): WatchList {
  const empty = { entities: [], instruments: [], topics: [] };
  if (!raw) return empty;
  try {
    const j = JSON.parse(decodeURIComponent(raw));
    return {
      entities: Array.isArray(j.entities)
        ? j.entities.filter((s: unknown) => typeof s === "string")
        : [],
      instruments: Array.isArray(j.instruments)
        ? j.instruments.filter((s: unknown) => typeof s === "string")
        : [],
      topics: Array.isArray(j.topics)
        ? j.topics.filter((s: unknown): s is Topic =>
            topics.some((t) => t.id === s),
          )
        : [],
    };
  } catch {
    return empty;
  }
}

export function emptyWatch(w: WatchList): boolean {
  return (
    w.entities.length === 0 &&
    (w.instruments?.length ?? 0) === 0 &&
    w.topics.length === 0
  );
}

/**
 * Entities a cluster is ABOUT — title + summary + every member headline,
 * run through the canonical ontology (same extractor the resolver uses).
 */
export function clusterEntities(c: StoryCluster): string[] {
  const text = [c.title, c.summary, ...c.articles.map((a) => a.title)].join(
    " ",
  );
  return extractEntities(text);
}

/**
 * Score one cluster against a watch list.
 * - each watched entity present: +0.35 (two+ entities = strong mission hit)
 * - any entity match at all: +0.25 floor (an event naming your watchlist
 *   matters more than a bare topic match)
 * - topic match: +0.15 (section preference only)
 */
export function scoreRelevance(c: StoryCluster, watch: WatchList): Relevance {
  const ents = clusterEntities(c);
  const matchedEntities = watch.entities.filter((e) => ents.includes(e));
  const topicMatch = watch.topics.includes(c.topic);
  const score = Math.min(
    1,
    matchedEntities.length * 0.35 +
      (matchedEntities.length > 0 ? 0.25 : 0) +
      (topicMatch ? 0.15 : 0),
  );
  return { score, matchedEntities, topicMatch };
}

export interface ScoredCluster {
  cluster: StoryCluster;
  relevance: Relevance;
}

/** Every scored cluster in an edition, deduped, best-first. */
export function rankEdition(
  edition: Edition,
  watch: WatchList,
): ScoredCluster[] {
  const seen = new Set<string>();
  const out: ScoredCluster[] = [];
  const all = [
    ...(edition.hero ? [edition.hero] : []),
    ...edition.pillars.flatMap((p) => p.events),
    ...edition.blindspots.internationalOnly,
    ...edition.blindspots.domesticOnly,
  ];
  for (const c of all) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const relevance = scoreRelevance(c, watch);
    if (relevance.score > 0) out.push({ cluster: c, relevance });
  }
  return out.sort((a, b) => b.relevance.score - a.relevance.score);
}

/**
 * Entity slugs present in the current edition, ranked by frequency — the
 * candidate set shown in the watch editor so users tap real entities
 * rather than guessing slug spellings.
 */
export function entitiesInEdition(edition: Edition, cap = 24): string[] {
  const freq = new Map<string, number>();
  const all = [
    ...(edition.hero ? [edition.hero] : []),
    ...edition.pillars.flatMap((p) => p.events),
    ...edition.blindspots.internationalOnly,
    ...edition.blindspots.domesticOnly,
  ];
  for (const c of all)
    for (const e of clusterEntities(c)) freq.set(e, (freq.get(e) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([e]) => e);
}
