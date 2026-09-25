import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fetchAllNews } from "./news";
import {
  clusterArticles,
  clusterRepText,
  extractBigrams,
  mergeClustersBySimilarity,
} from "./cluster";
import { entityLabel } from "./entities";
import { isNoise, normalizeText, STOP_WORDS } from "./model";
import { analyzeCluster, deterministicNhanDinh } from "./analysis";
import { generateNhanDinh, geminiEnabled } from "./gemini";
import { generateClaims, extractClaimsLLM } from "./claims";
import { cosine, embedArticles } from "./embed";
import { applyTracking } from "./tracking";
import { feeds } from "./feeds";
import { persistEdition } from "./db/persist";
import { getClaimCounts, getConfidenceStates } from "./db/read";
import { dbEnabled } from "./db/pool";
import {
  getLatestEditionSnapshot,
  saveEditionSnapshot,
} from "./db/editionSnapshot";
import type {
  ClaimAnalysis,
  Edition,
  EventAnalysis,
  NhanDinh,
  Pillar,
  PillarId,
  StoryCluster,
} from "./model";
import type { ExtractedClaim } from "./db/writer";

const REVALIDATE_SECONDS = 15 * 60;
const MAX_LLM_CLUSTERS = 8;
/** top clusters embedded for the semantic merge — sized to the embed quota */
const SEMANTIC_MERGE_TOP = 80;
const WIRE_COUNT = 40;
const TRENDING_COUNT = 12;

const PILLAR_DEFS: { id: PillarId; label: string }[] = [
  { id: "geopolitics", label: "Địa chính trị" },
  { id: "economy", label: "Kinh tế" },
  { id: "tech", label: "Công nghệ & AI" },
  { id: "vietnam", label: "Việt Nam" },
];

function pillarOf(cluster: StoryCluster): PillarId {
  if (cluster.strategicDomain === "geopolitics") return "geopolitics";
  if (cluster.strategicDomain === "economy" || cluster.scope === "business")
    return "economy";
  if (
    cluster.strategicDomain === "frontier_tech" ||
    cluster.scope === "tech" ||
    cluster.scope === "science"
  )
    return "tech";
  if (
    cluster.scope === "vietnam" ||
    cluster.strategicDomain === "national_policy"
  )
    return "vietnam";
  // general clusters fall to the pillar of their scope
  if (cluster.scope === "world") return "geopolitics";
  return "vietnam";
}

/**
 * First-seen raw surface form for each normalized bigram, so the trending
 * strip can render "doanh nghiệp" instead of the diacritic-stripped key.
 */
function surfaceForms(text: string): Map<string, string> {
  const forms = new Map<string, string>();
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.,%/-]+$/gu, "");
    const w2 = words[i + 1].replace(
      /^[^\p{L}\p{N}]+|[^\p{L}\p{N}.,%/-]+$/gu,
      "",
    );
    const n1 = normalizeText(w1);
    const n2 = normalizeText(w2);
    if (
      n1.length < 3 ||
      n2.length < 3 ||
      STOP_WORDS.has(n1) ||
      STOP_WORDS.has(n2) ||
      /^\d+$/.test(n1) ||
      /^\d+$/.test(n2)
    )
      continue;
    const key = `${n1} ${n2}`;
    if (!forms.has(key)) forms.set(key, `${w1} ${w2}`);
  }
  return forms;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Trending entities/bigrams across clean cluster titles — the "đang nóng" strip. */
function computeTrending(
  clusters: StoryCluster[],
): { term: string; count: number }[] {
  const counts = new Map<string, number>();
  const forms = new Map<string, string>();
  for (const c of clusters) {
    const text = `${c.title} ${c.summary.slice(0, 300)}`;
    for (const [key, form] of surfaceForms(text)) {
      if (!forms.has(key)) forms.set(key, form);
    }
    for (const bg of extractBigrams(text)) {
      const entityTokens = bg.split(" ").filter((t) => t.startsWith("entity_"));
      if (entityTokens.length) {
        // entities are the high-signal chips; the mixed pair is dropped
        for (const e of entityTokens) counts.set(e, (counts.get(e) ?? 0) + 3);
      } else {
        counts.set(bg, (counts.get(bg) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRENDING_COUNT)
    .map(([term, count]) => ({
      term: term.startsWith("entity_")
        ? entityLabel(term)
        : titleCase(forms.get(term) ?? term),
      count,
    }));
}

export async function buildEdition(): Promise<Edition> {
  // stage timing — a silent multi-hour pipeline is undebuggable on a CI
  // runner; these lines are how we see where a run actually is.
  const t0 = Date.now();
  const lap = (name: string) =>
    console.log(`[edition] ${name} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const { articles, sources } = await fetchAllNews();
  lap(`fetched ${articles.length} articles / ${sources.length} sources`);
  const apiKey = process.env.GEMINI_API_KEY;

  let clusters = clusterArticles(articles).filter(
    (c) => !isNoise(c.leadArticle) && c.articles.length > 0,
  );
  lap(`clustered → ${clusters.length}`);

  // semantic merge pass: embed representative text of the top clusters and
  // union-find merge pairs the lexical pass could not join (vi/en
  // paraphrases share no vocabulary). Bounded to the head of the ranking —
  // the free-tier embed quota (~100 req/min) cannot cover every cluster.
  if (apiKey && clusters.length > 1) {
    const tops = clusters.slice(0, SEMANTIC_MERGE_TOP);
    const vectors = await embedArticles(
      apiKey,
      tops.map((c) => ({ id: c.id, text: clusterRepText(c) })),
    );
    if (vectors.size >= 2) {
      const merged = mergeClustersBySimilarity(tops, (a, b) => {
        const va = vectors.get(a.id);
        const vb = vectors.get(b.id);
        return va && vb ? cosine(va, vb) : 0;
      });
      clusters = [...merged, ...clusters.slice(SEMANTIC_MERGE_TOP)].sort(
        (a, b) => b.significanceScore - a.significanceScore,
      );
    }
    lap(`semantic merge (${vectors.size}/${tops.length} embedded)`);
  }

  // temporal layer: attach momentum + persist snapshot for the next edition
  const editionNow = new Date().toISOString();
  applyTracking(clusters, editionNow);

  // Hero: highest-significance strategic event, else top cluster
  const hero =
    clusters.find(
      (c) => c.strategicDomain && c.strategicDomain !== "general",
    ) ??
    clusters[0] ??
    null;

  // Pillars: fill each with its top events
  const usedIds = new Set<string>();
  if (hero) usedIds.add(hero.id);
  const pillars: Pillar[] = PILLAR_DEFS.map((def) => ({
    ...def,
    events: [],
  }));
  const pillarMap = new Map(pillars.map((p) => [p.id, p]));
  for (const cluster of clusters) {
    const pillar = pillarMap.get(pillarOf(cluster));
    if (!pillar) continue;
    if (pillar.events.length >= 5) continue;
    if (!usedIds.has(cluster.id)) {
      pillar.events.push(cluster);
      usedIds.add(cluster.id);
    }
  }

  // Blindspots: multi-source clusters covered by only one side
  const internationalOnly = clusters
    .filter((c) => c.blindspot === "international-only")
    .slice(0, 5);
  const domesticOnly = clusters
    .filter((c) => c.blindspot === "domestic-only")
    .slice(0, 5);

  // Analysis targets: hero + pillar events + blindspots (bounded)
  const analyzeTargets = new Map<string, StoryCluster>();
  if (hero) analyzeTargets.set(hero.id, hero);
  for (const p of pillars)
    for (const c of p.events) analyzeTargets.set(c.id, c);
  for (const c of [...internationalOnly, ...domesticOnly])
    analyzeTargets.set(c.id, c);

  // Optional Gemini nhận định + claim matrix for the top clusters —
  // both fail-closed, batched at bounded parallelism to stay under maxDuration.
  const sortedTargets = [...analyzeTargets.values()].sort(
    (a, b) => b.significanceScore - a.significanceScore,
  );
  const llmTargets = apiKey ? sortedTargets.slice(0, MAX_LLM_CLUSTERS) : [];
  const generated = new Map<string, NhanDinh>();
  const claimsMap = new Map<string, ClaimAnalysis>();
  const extractedMap = new Map<string, ExtractedClaim[]>();
  const LLM_CONCURRENCY = 4;
  for (let i = 0; i < llmTargets.length; i += LLM_CONCURRENCY) {
    const slice = llmTargets.slice(i, i + LLM_CONCURRENCY);
    const results = await Promise.all(
      slice.flatMap((c) => [
        generateNhanDinh(apiKey!, c).then((v) => ["nd", c.id, v] as const),
        generateClaims(apiKey!, c).then((v) => ["cl", c.id, v] as const),
        extractClaimsLLM(apiKey!, c).then((v) => ["ex", c.id, v] as const),
      ]),
    );
    for (const [kind, id, v] of results) {
      if (!v || (Array.isArray(v) && v.length === 0)) continue;
      if (kind === "nd") generated.set(id, v as NhanDinh);
      else if (kind === "cl") claimsMap.set(id, v as ClaimAnalysis);
      else extractedMap.set(id, v as ExtractedClaim[]);
    }
  }
  lap(
    `LLM pass (${generated.size} nhận định, ${claimsMap.size} claim matrices, ${extractedMap.size} extracted)`,
  );

  // evidence layer: persist the final clusters as Evidence → Event → Claim
  // → Change history. LLM-extracted claims merge into the same canonical
  // tables. Inert without DATABASE_URL; a failure must never sink the edition.
  const feedByName = new Map(feeds.map((f) => [f.name, f]));
  let eventIds: Record<string, string> | undefined;
  try {
    const r = await persistEdition(clusters, feedByName, extractedMap, {
      sources,
    });
    if (r.eventIds.size > 0) eventIds = Object.fromEntries(r.eventIds);
    if (r.persisted > 0 || r.failed > 0)
      console.log(
        `Event history: ${r.persisted} clusters persisted, ${r.failed} failed`,
      );
    lap(`persist (${r.persisted} ok / ${r.failed} failed)`);
  } catch (error) {
    console.warn(
      "persistEdition failed:",
      error instanceof Error ? error.message : error,
    );
  }

  // canonical claim counts surface as the "N dữ kiện" chip on cards —
  // read back from Postgres so the chip matches the EventView modal.
  let claimCounts: Record<string, number> | undefined;
  let confidences: Edition["confidences"];
  if (eventIds) {
    try {
      const ids = Object.values(eventIds);
      const [counts, confs] = await Promise.all([
        getClaimCounts(ids),
        getConfidenceStates(ids),
      ]);
      const m: Record<string, number> = {};
      const cf: Record<string, "strong" | "moderate" | "weak"> = {};
      for (const [clusterId, eventId] of Object.entries(eventIds)) {
        const c = counts.get(eventId);
        if (c) m[clusterId] = c;
        const s = confs.get(eventId);
        if (s) cf[clusterId] = s;
      }
      if (Object.keys(m).length > 0) claimCounts = m;
      if (Object.keys(cf).length > 0) confidences = cf;
    } catch {
      /* optional — chips hide without it */
    }
  }

  const analyses: Record<string, EventAnalysis> = {};
  for (const [id, cluster] of analyzeTargets) {
    analyses[id] = {
      ...analyzeCluster(cluster, generated.get(id)),
      claims: claimsMap.get(id),
    };
  }

  // diff counters for the status bar — only events the user actually sees
  const changes = { newEvents: 0, accelerating: 0 };
  for (const cluster of analyzeTargets.values()) {
    if (cluster.momentum?.phase === "emerging") changes.newEvents++;
    if (cluster.momentum?.phase === "accelerating") changes.accelerating++;
  }

  const clusteredIds = new Set(
    clusters.flatMap((c) => c.articles.map((a) => a.id)),
  );
  const wire = articles
    .filter((a) => !clusteredIds.has(a.id))
    .slice(0, WIRE_COUNT);

  return {
    hero,
    heroAnalysis: hero ? (analyses[hero.id] ?? null) : null,
    pillars,
    blindspots: { internationalOnly, domesticOnly },
    analyses,
    wire,
    trending: computeTrending(clusters),
    sources,
    updatedAt: editionNow,
    stale: !articles.length,
    llmEnabled: geminiEnabled(),
    totalArticles: articles.length,
    changes,
    eventIds,
    claimCounts,
    confidences,
  };
}

/* ---------------- stale-while-revalidate snapshot ----------------
 * unstable_cache is sync-on-miss: every revalidate window one request ate
 * the whole multi-minute cold build and the page looked dead. Instead
 * each built edition is persisted to disk; getEdition serves the
 * last-good snapshot instantly and refreshes in the background once it
 * goes stale. Only the very first boot (no snapshot) still waits.
 *
 * Serverless wrinkle: on Vercel .cache/ is ephemeral per-invocation, so
 * every build also writes an edition_snapshots row — reads there prefer
 * the DB (fs is empty anyway), locally fs stays first (cheap). And
 * background rebuilds are local-only: a rebuild kicked inside a request
 * dies when the response does, so on Vercel we serve the last-good
 * snapshot and let the external builder (scripts/build-edition.mts)
 * refresh the row. */
const SNAPSHOT_PATH =
  process.env.THUNDERFEED_EDITION_CACHE ?? ".cache/edition.json";

/** Degrade edition when no snapshot exists — Vercel is a pure reader;
 *  building the full pipeline inside a request would hold the lambda
 *  until maxDuration kills it. Empty beats a doomed 3-minute build. */
const EMPTY_EDITION: Edition = {
  hero: null,
  heroAnalysis: null,
  pillars: [],
  blindspots: { internationalOnly: [], domesticOnly: [] },
  analyses: {},
  wire: [],
  trending: [],
  sources: [],
  updatedAt: null,
  stale: true,
  llmEnabled: false,
  totalArticles: 0,
  changes: { newEvents: 0, accelerating: 0 },
};

/** Warm lambdas re-check a stale snapshot at most this often — without
 *  the throttle every request between editions pays a DB roundtrip. */
const STALE_RECHECK_MS = 60_000;

let memEdition: Edition | null = null;
let lastStaleCheck = 0;
let inflight: Promise<Edition> | null = null;

function readFsSnapshot(): Edition | null {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return null;
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Edition;
  } catch {
    return null;
  }
}

async function readDbSnapshot(): Promise<Edition | null> {
  if (!dbEnabled()) return null;
  try {
    return await getLatestEditionSnapshot();
  } catch {
    return null; // optional store — a failure is just a cache miss
  }
}

async function loadSnapshot(): Promise<Edition | null> {
  if (memEdition) return memEdition;
  memEdition = process.env.VERCEL
    ? ((await readDbSnapshot()) ?? readFsSnapshot())
    : (readFsSnapshot() ?? (await readDbSnapshot()));
  return memEdition;
}

async function saveSnapshot(e: Edition): Promise<void> {
  memEdition = e;
  try {
    const dir = path.dirname(SNAPSHOT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(e));
  } catch {
    // snapshot is an availability optimization — never fail the edition
  }
  if (!dbEnabled()) return;
  try {
    await saveEditionSnapshot(e);
  } catch (error) {
    console.warn(
      "edition snapshot save failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function refreshEdition(): Promise<Edition> {
  inflight ??= buildEdition()
    .then(async (e) => {
      await saveSnapshot(e);
      return e;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getEdition(): Promise<Edition> {
  let snap = await loadSnapshot();
  if (snap) {
    const built = snap.updatedAt ? Date.parse(snap.updatedAt) : 0;
    const stale = Date.now() - built > REVALIDATE_SECONDS * 1000;
    if (stale) {
      if (process.env.VERCEL) {
        /* serverless can't rebuild in the background — but a warm lambda
           pinning memEdition would serve the load-time snapshot forever.
           Stale ⇒ re-read the store, throttled; the external builder
           refreshes the row on its own cadence. */
        if (Date.now() - lastStaleCheck > STALE_RECHECK_MS) {
          lastStaleCheck = Date.now();
          memEdition = null;
          const fresh = await readDbSnapshot();
          if (fresh) {
            memEdition = fresh;
            snap = fresh;
          } else {
            memEdition = snap;
          }
        }
      } else {
        void refreshEdition().catch(() => {});
      }
    }
    if (snap) return snap;
  }
  /* no snapshot anywhere: locally we can afford the build; on Vercel a
     request-time build is a guaranteed timeout, so degrade instead */
  if (process.env.VERCEL) return EMPTY_EDITION;
  return refreshEdition();
}

export { REVALIDATE_SECONDS };
