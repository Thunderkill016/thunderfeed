/**
 * Cross-edition story tracking — the temporal layer.
 * Persists a light snapshot of each cluster (article ids, source names,
 * keywords, entity aliases) to a JSON file, so each new edition can tell
 * which stories are emerging, accelerating, steady, or cooling — the
 * Dataminr-style signal a single snapshot can't express.
 *
 * Best-effort by contract: any I/O failure degrades to no momentum data,
 * never to a failed edition build.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeText,
  STOP_WORDS,
  type MomentumPhase,
  type StoryCluster,
} from "./model";
import { extractBigrams } from "./cluster";

const STATE_PATH =
  process.env.TRACKING_STATE_PATH ??
  join(process.cwd(), ".cache", "clusters.json");
const MAX_AGE_MS = 72 * 3_600_000;
const COOLING_AGE_HOURS = 6;

type Tracked = {
  key: string;
  title: string;
  firstSeen: string;
  lastSeen: string;
  articleIds: string[];
  sourceNames: string[];
  keywords: string[];
  entities: string[];
};

type Store = { clusters: Tracked[] };

function keywordsOf(cluster: StoryCluster): string[] {
  return [
    ...new Set(
      normalizeText(cluster.title)
        .split(" ")
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ].sort();
}

function entitiesOf(cluster: StoryCluster): string[] {
  const entities = new Set<string>();
  for (const bg of extractBigrams(cluster.title))
    for (const t of bg.split(" ")) if (t.startsWith("entity_")) entities.add(t);
  return [...entities].sort();
}

/** Same story iff shared article ids, or entity + keyword agreement. */
function sameStory(
  t: Tracked,
  c: StoryCluster,
  now: {
    ids: Set<string>;
    kws: Set<string>;
    ents: Set<string>;
  },
): boolean {
  for (const id of c.articles.map((a) => a.id))
    if (t.articleIds.includes(id)) return true;
  let sharedEnts = 0;
  for (const e of t.entities) if (now.ents.has(e)) sharedEnts++;
  let sharedKws = 0;
  for (const k of t.keywords) if (now.kws.has(k)) sharedKws++;
  return sharedEnts >= 2 || (sharedEnts >= 1 && sharedKws >= 2);
}

function loadStore(): Store {
  try {
    const raw = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ STATE_PATH, "utf8"),
    ) as Store;
    return Array.isArray(raw?.clusters) ? raw : { clusters: [] };
  } catch {
    return { clusters: [] };
  }
}

function saveStore(store: Store): void {
  try {
    mkdirSync(join(STATE_PATH, ".."), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(store));
  } catch {
    /* tracking is best-effort */
  }
}

export interface TrackingChanges {
  newEvents: number;
  accelerating: number;
}

/**
 * Attach `cluster.momentum` in place and persist the new snapshot.
 * Returns per-edition diff counters for the status bar.
 */
export function applyTracking(
  clusters: StoryCluster[],
  nowIso: string,
): TrackingChanges {
  const nowMs = Date.parse(nowIso);
  const store = loadStore();
  store.clusters = store.clusters.filter(
    (t) => nowMs - Date.parse(t.lastSeen) < MAX_AGE_MS,
  );
  const used = new Set<string>();
  const changes: TrackingChanges = { newEvents: 0, accelerating: 0 };

  for (const c of clusters) {
    const ctx = {
      ids: new Set(c.articles.map((a) => a.id)),
      kws: new Set(keywordsOf(c)),
      ents: new Set(entitiesOf(c)),
    };
    const hit = store.clusters.find(
      (t) => !used.has(t.key) && sameStory(t, c, ctx),
    );

    const ids = c.articles.map((a) => a.id);
    const names = c.sources.map((s) => s.name);

    if (!hit) {
      c.momentum = {
        phase: "emerging",
        newArticles: ids.length,
        newSources: names,
        firstSeen: nowIso,
      };
      changes.newEvents++;
      store.clusters.push({
        key: c.id,
        title: c.title,
        firstSeen: nowIso,
        lastSeen: nowIso,
        articleIds: ids,
        sourceNames: names,
        keywords: [...ctx.kws],
        entities: [...ctx.ents],
      });
      continue;
    }

    used.add(hit.key);
    const newArticles = ids.filter((id) => !hit.articleIds.includes(id)).length;
    const newSources = names.filter((n) => !hit.sourceNames.includes(n));
    const ageHours = (nowMs - Date.parse(hit.firstSeen)) / 3_600_000;

    let phase: MomentumPhase;
    if (newArticles >= 2 || newSources.length >= 1) phase = "accelerating";
    else if (newArticles === 0 && ageHours > COOLING_AGE_HOURS)
      phase = "cooling";
    else phase = "steady";

    c.momentum = {
      phase,
      newArticles,
      newSources,
      firstSeen: hit.firstSeen,
    };
    if (phase === "accelerating") changes.accelerating++;

    Object.assign(hit, {
      title: c.title,
      lastSeen: nowIso,
      articleIds: ids,
      sourceNames: names,
      keywords: [...ctx.kws],
      entities: [...ctx.ents],
    });
  }

  saveStore(store);
  return changes;
}
