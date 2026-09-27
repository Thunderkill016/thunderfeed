/* Radar Quality Lab — score buildRadarFeed() rankings against the labeled
 * corpus in tests/fixtures/radar-corpus.json.
 *
 *   npx tsx scripts/radar/bench.mts [--corpus path]
 *
 *   default corpus: tests/fixtures/radar-corpus.json (DEV — its labels
 *   have shaped past tuning). HOLDOUT files come from
 *   scripts/radar/holdout-dump.mts with q='unlabeled': they rank like
 *   any item but are excluded from P@K/noise denominators, and the top
 *   unlabeled items print for blind human review.
 *
 * Metrics per persona:
 *   P@5, P@10      — fraction of top-k that is useful|must_see
 *   must-see recall— must_see items that landed in the capped feed
 *   noise@10       — fraction of top-10 labeled noise
 *   dup rate       — same-story duplicates in feed (identical titles)
 *   relevance hits — top-10 items personally relevant to the persona
 *
 * Labels are human judgment in the corpus, not derived from the ranker —
 * that's what makes this a benchmark rather than a tautology.
 */
import { readFileSync } from "node:fs";
import { buildRadarFeed } from "../../lib/radar.ts";
import { canonicalEntity, extractEntities } from "../../lib/entities.ts";
import type { WatchList } from "../../lib/relevance.ts";
import type { DataDeltaView } from "../../lib/db/read.ts";
import type { EventListItem } from "../../lib/db/read.ts";

interface CorpusItem {
  ref: string;
  kind: "delta" | "event";
  q: "must_see" | "useful" | "background" | "noise" | "unlabeled";
  relevantTo: string[];
  data: Record<string, unknown>;
}
const corpusIdx = process.argv.indexOf("--corpus");
const corpusPath =
  corpusIdx >= 0
    ? process.argv[corpusIdx + 1]
    : new URL("../../tests/fixtures/radar-corpus.json", import.meta.url)
        .pathname;
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  dumpedAt: string;
  items: CorpusItem[];
};

const PERSONAS: Record<string, { label: string; watch: WatchList }> = {
  A: {
    label: "kinh tế VN chung",
    watch: {
      entities: ["nhnn", "federal_reserve"],
      instruments: ["vnindex"],
      topics: ["vietnam", "business"],
    },
  },
  B: {
    label: "vàng + USD/VND",
    watch: {
      entities: [],
      instruments: ["vang", "ty_gia", "usdt"],
      topics: [],
    },
  },
  C: {
    label: "BTC + crypto",
    watch: {
      entities: [],
      instruments: ["bitcoin", "ethereum", "usdt"],
      topics: [],
    },
  },
};

const byId = new Map<string, CorpusItem>();
const deltas: DataDeltaView[] = [];
const events: EventListItem[] = [];
for (const it of corpus.items) {
  byId.set(it.data.id as string, it);
  if (it.kind === "delta") deltas.push(it.data as unknown as DataDeltaView);
  else {
    (it.data as { entityKeys?: string[] }).entityKeys = extractEntities(
      (it.data as { title: string }).title,
    );
    events.push(it.data as unknown as EventListItem);
  }
}
const nowMs = Date.parse(corpus.dumpedAt) + 3_600_000;

const GOOD = new Set(["useful", "must_see"]);

interface Metrics {
  p5: number;
  p10: number;
  recall: number;
  recallAll: number;
  laneRecall: number;
  noiseAt10: number;
  dupRate: number;
  relHits: number;
  feedSize: number;
}

function evaluate(persona: string, watch: WatchList): Metrics {
  const feed = buildRadarFeed(deltas, events, watch, nowMs, 22, null);
  const q = (id: string) => byId.get(id)?.q ?? "noise";
  const rel = (id: string) =>
    byId.get(id)?.relevantTo.includes(persona) ?? false;

  const top5 = feed.slice(0, 5);
  const top10 = feed.slice(0, 10);
  /* dup = identical title OR same-story. "Same story" means ≥2 shared
   * DISTINCTIVE entities — country/region/place slugs don't count (two
   * unrelated stories can share vietnam+us; matching the suppression rule
   * keeps the metric honest about what the product actually dedupes). */
  const GEO_TYPES = new Set(["country", "region", "place"]);
  const distinctive = (keys: string[]) =>
    keys.filter((k) => !GEO_TYPES.has(canonicalEntity(k)?.type ?? ""));
  const titles = new Set<string>();
  const seenEnts: string[][] = [];
  let dups = 0;
  for (const i of feed) {
    const key = i.title.trim().toLowerCase();
    const ents = distinctive(i.entityKeys ?? []);
    if (
      titles.has(key) ||
      seenEnts.some((s) => ents.filter((e) => s.includes(e)).length >= 2)
    )
      dups++;
    titles.add(key);
    seenEnts.push(ents);
  }
  /* recall counts covered STORIES: a must-see suppressed as a same-story
   *  duplicate still counts if its shadowing item made the feed */
  const feedEnts = feed.map((i) => i.entityKeys ?? []);
  const mustSeeItems = corpus.items.filter((i) => i.q === "must_see");
  const covered = (it: CorpusItem) =>
    feed.some((f) => f.id === it.data.id) ||
    feedEnts.some(
      (fk) =>
        it.kind === "event" &&
        fk.length > 0 &&
        ((it.data as { entityKeys?: string[] }).entityKeys ?? []).filter((e) =>
          fk.includes(e),
        ).length >= 2,
    );
  const recallCapped =
    mustSeeItems.filter(covered).length / Math.max(1, mustSeeItems.length);
  const uncapped = buildRadarFeed(deltas, events, watch, nowMs, 9999, null);
  const uncappedEnts = uncapped.map((i) => i.entityKeys ?? []);
  const coveredAll = (it: CorpusItem) =>
    uncapped.some((f) => f.id === it.data.id) ||
    uncappedEnts.some(
      (fk) =>
        it.kind === "event" &&
        fk.length > 0 &&
        ((it.data as { entityKeys?: string[] }).entityKeys ?? []).filter((e) =>
          fk.includes(e),
        ).length >= 2,
    );
  const recallAll =
    mustSeeItems.filter(coveredAll).length / Math.max(1, mustSeeItems.length);
  /* two-lane coverage (R6d): the homepage isn't one top-N list — a new
   * lane (isNew vs previousSeenAt, ≤7) plus a still-material lane
   * (older, score≥45, ≤5). A must-see "covered" by either lane counts. */
  const prevSeen = nowMs - 12 * 3_600_000;
  const laneFeed = buildRadarFeed(deltas, events, watch, nowMs, 24, prevSeen);
  const lanes = [
    ...laneFeed.filter((i) => i.isNew).slice(0, 7),
    ...laneFeed.filter((i) => !i.isNew && i.score >= 45).slice(0, 5),
  ];
  const laneEnts = lanes.map((i) => i.entityKeys ?? []);
  const laneCovered = (it: CorpusItem) =>
    lanes.some((f) => f.id === it.data.id) ||
    laneEnts.some(
      (fk) =>
        it.kind === "event" &&
        fk.length > 0 &&
        ((it.data as { entityKeys?: string[] }).entityKeys ?? []).filter((e) =>
          fk.includes(e),
        ).length >= 2,
    );
  const laneRecall =
    mustSeeItems.filter(laneCovered).length / Math.max(1, mustSeeItems.length);
  /* unlabeled (holdout) items still occupy feed slots but can't be
   * scored — denominators count labeled items only, so a holdout file
   * never fabricates precision */
  const labeled5 = top5.filter((i) => q(i.id) !== "unlabeled");
  const labeled10 = top10.filter((i) => q(i.id) !== "unlabeled");
  return {
    laneRecall,
    p5:
      labeled5.filter((i) => GOOD.has(q(i.id))).length /
      Math.max(1, labeled5.length),
    p10:
      labeled10.filter((i) => GOOD.has(q(i.id))).length /
      Math.max(1, labeled10.length),
    recall: recallCapped,
    recallAll,
    noiseAt10:
      labeled10.filter((i) => q(i.id) === "noise").length /
      Math.max(1, labeled10.length),
    dupRate: feed.length ? dups / feed.length : 0,
    relHits: top10.filter((i) => rel(i.id)).length,
    feedSize: feed.length,
  };
}

console.log(
  `corpus: ${corpus.items.length} items (${deltas.length} deltas, ${events.length} events)`,
);
console.log(
  "persona | feed | P@5 | P@10 | recall@22 | recall@gate | recall@lanes | noise@10 | dup | rel@10",
);
const all: Record<string, Metrics> = {};
for (const [k, p] of Object.entries(PERSONAS)) {
  const m = evaluate(k, p.watch);
  all[k] = m;
  console.log(
    `${k} ${p.label.padEnd(16)} | ${String(m.feedSize).padStart(4)} | ` +
      `${m.p5.toFixed(2)} | ${m.p10.toFixed(2)} | ${m.recall.toFixed(2)} | ${m.recallAll.toFixed(2)} | ${m.laneRecall.toFixed(2)} | ` +
      `${m.noiseAt10.toFixed(2)} | ${m.dupRate.toFixed(2)} | ${m.relHits}`,
  );
}

/* Show what's actually in each feed — the qualitative read matters as much
 * as the scalar metrics. */
for (const [k, p] of Object.entries(PERSONAS)) {
  const feed = buildRadarFeed(deltas, events, p.watch, nowMs, 22, null);
  console.log(`\n=== persona ${k} (${p.label}) top-14 ===`);
  feed.forEach((i, n) => {
    const c = byId.get(i.id);
    console.log(
      `${String(n + 1).padStart(2)}. [${String(i.score).padStart(5)}] ` +
        `${(c?.q ?? "?").padEnd(10)} ${i.badge.padEnd(12)} ${i.title.slice(0, 80)}`,
    );
  });
}

/* blind review: unlabeled holdout items the radar promotes — label them
 * by judgment, THEN rerun metrics. Never tune against hidden labels. */
for (const [k, p] of Object.entries(PERSONAS)) {
  const feed = buildRadarFeed(deltas, events, p.watch, nowMs, 22, null);
  const blind = feed
    .filter((i) => byId.get(i.id)?.q === "unlabeled")
    .slice(0, 10);
  if (!blind.length) continue;
  console.log(`\n=== persona ${k}: unlabeled top-10 (review blind) ===`);
  blind.forEach((i) => {
    const c = byId.get(i.id);
    console.log(
      `  ${c?.ref ?? i.id.slice(0, 8)} [${String(i.score).padStart(5)}] ${i.title.slice(0, 78)}`,
    );
  });
}

/* which must-sees still miss the capped feed */
for (const [k, p] of Object.entries(PERSONAS)) {
  const feed = buildRadarFeed(deltas, events, p.watch, nowMs, 22, null);
  const feedEnts = feed.map((i) => i.entityKeys ?? []);
  const miss = corpus.items.filter(
    (it) =>
      it.q === "must_see" &&
      !feed.some((f) => f.id === it.data.id) &&
      !feedEnts.some(
        (fk) =>
          it.kind === "event" &&
          fk.length > 0 &&
          ((it.data as { entityKeys?: string[] }).entityKeys ?? []).filter(
            (e) => fk.includes(e),
          ).length >= 2,
      ),
  );
  console.log(`\nuncovered must-see for ${k}:`);
  for (const m of miss)
    console.log(
      `  ${m.ref} ${String(m.data.title ?? m.data.summary).slice(0, 80)}`,
    );
}
