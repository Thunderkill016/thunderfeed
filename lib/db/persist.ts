/**
 * Bridge between the news refresh pipeline and the append-only store.
 * refreshNews() produces deduplicated articles; this turns the top
 * clusters into Evidence → Event → Claim → Change history.
 * Inert without DATABASE_URL — persistence is optional, like the cache.
 */

import type { Article, SourceStatus, StoryCluster } from "../model";
import type { Feed } from "../feeds";
import type { Pool, PoolClient } from "pg";
import { dbEnabled, getPool, toJsonb, canonValue } from "./pool";
import { extractClaims } from "./extract";
import { embedArticles } from "../embed";
import { clusterRepTextV2, repHash } from "../resolver";
import {
  persistCluster,
  resolveStaleEvents,
  type ExtractedClaim,
  type SourceMeta,
} from "./writer";

/* Bound DB growth per refresh: only the most significant clusters persist.
   60 clusters × ~3 evidence versions stays well under free-tier write
   budgets while covering the whole front page. */
const PERSIST_TOP_CLUSTERS = 60;
/* Two concurrent /api/edition builds run their own persist loops; without
   serialization they interleave writes on shared sources/events rows —
   the observed deadlock + duplicate-source failures. A session-level
   advisory lock makes persist single-writer across ALL node processes and
   releases automatically if the holder crashes. */
const PERSIST_LOCK_KEY = 727274;
/* Waiters must NOT hold a pool connection while queued: the pool is small
   (max 4), so N queued blocking locks would starve the lock holder of the
   connection it needs to finish — a Node-level deadlock. try-lock + sleep
   keeps waiters connectionless; ~2.5 polls/sec is negligible load. */
const PERSIST_LOCK_RETRY_MS = 400;

/**
 * Take the edition-persist advisory lock without starving the pool.
 * A plain `pg_advisory_lock` holds its connection while queued — with a
 * small pool, a few waiters exhaust it and the lock holder never gets a
 * working connection (Node-level deadlock). try-lock + sleep instead.
 */
async function acquirePersistLock(pool: Pool): Promise<PoolClient> {
  for (;;) {
    const c = await pool.connect();
    const { rows } = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [PERSIST_LOCK_KEY],
    );
    if (rows[0].ok) return c;
    c.release();
    await new Promise((r) => setTimeout(r, PERSIST_LOCK_RETRY_MS));
  }
}

/**
 * Publisher identity + discovery path for one article. `article.ingest` is
 * authoritative (fetchers tag every observation); feed registry only fills
 * region/language/country gaps.
 */
function metaFor(article: Article, feed: Feed | undefined): SourceMeta {
  const ingest = article.ingest;
  return {
    kind: ingest?.sourceKind ?? "publisher",
    region:
      feed?.region === "vietnam" || article.region === "vietnam"
        ? "vietnam"
        : "global",
    language: feed?.language ?? article.language,
    country: feed?.country,
    domain: ingest?.sourceDomain,
    channel: ingest?.discoveredVia,
  };
}

/**
 * Persist one edition build. Callers pass the FINAL clusters (post
 * semantic-merge) so persisted events match what the UI renders.
 * `extraClaims` merges LLM-extracted claims (keyed by cluster id) into
 * the same canonical Claim tables — the deterministic extractor wins
 * on identical (source, key, value) so a fact never double-writes.
 * Each cluster commits independently — one bad cluster must not
 * sink the edition (transactional isolation).
 */
export async function persistEdition(
  allClusters: StoryCluster[],
  feedByName: Map<string, Feed>,
  extraClaims?: Map<string, ExtractedClaim[]>,
  opts: { sources?: SourceStatus[] } = {},
): Promise<{
  persisted: number;
  failed: number;
  eventIds: Map<string, string>;
}> {
  if (!dbEnabled() || allClusters.length === 0)
    return { persisted: 0, failed: 0, eventIds: new Map() };

  const clusters = [...allClusters]
    .sort((a, b) => b.significanceScore - a.significanceScore)
    .slice(0, PERSIST_TOP_CLUSTERS);

  const sourceMeta: Record<string, SourceMeta> = {};
  for (const c of clusters)
    for (const a of c.articles)
      sourceMeta[a.source] ??= metaFor(a, feedByName.get(a.source));

  let persisted = 0;
  let failed = 0;
  const eventIds = new Map<string, string>();
  // coverage telemetry — which sources mint versions vs. just re-observing
  const statsBySource = new Map<
    string,
    {
      newVersions: number;
      reObserved: number;
      events: Set<string>;
      materialEvents: Set<string>;
      primaryAttached: number;
      origins: number;
      derived: number;
      unknown: number;
    }
  >();
  // semantic scorer for the persistent resolver — absent key ⇒ the
  // resolver runs its deterministic lexical path (never a hard dep)
  const apiKey = process.env.GEMINI_API_KEY;
  const embedder = apiKey
    ? async (texts: string[]) => {
        const items = texts.map((t) => ({ id: repHash(t), text: t }));
        const v = await embedArticles(apiKey, items);
        return items.map((it) => v.get(it.id) ?? null);
      }
    : undefined;
  /* Claim extraction is deterministic — compute it up front so every
     incoming rep can be embedded BEFORE the advisory lock is taken. The
     embedder is a network call; running it inside the lock serializes all
     builds on Gemini latency. The in-transaction embedder then hits the
     warmed file cache for incoming reps. */
  const claimsByCluster = new Map<string, ExtractedClaim[]>();
  for (const c of clusters) {
    const llmClaims = extraClaims?.get(c.id) ?? [];
    const deterministic = extractClaims(c);
    const seen = new Set(
      deterministic.map(
        (d) =>
          `${d.assertedBy}|${d.claimKey}|${JSON.stringify(canonValue(d.value))}|${d.unit ?? ""}`,
      ),
    );
    claimsByCluster.set(c.id, [
      ...deterministic,
      ...llmClaims.filter(
        (l) =>
          !seen.has(
            `${l.assertedBy}|${l.claimKey}|${JSON.stringify(canonValue(l.value))}|${l.unit ?? ""}`,
          ),
      ),
    ]);
  }
  if (embedder)
    await embedder(
      clusters.map((c) => clusterRepTextV2(c, claimsByCluster.get(c.id)!)),
    ).catch(() => []);
  const pool = getPool();
  const lockClient = await acquirePersistLock(pool);
  try {
    for (const c of clusters) {
      const claims = claimsByCluster.get(c.id)!;
      try {
        const r = await persistCluster(c, claims, { sourceMeta, embedder });
        eventIds.set(c.id, r.eventId);
        persisted++;
        for (const i of r.ingested) {
          let s = statsBySource.get(i.source);
          if (!s) {
            s = {
              newVersions: 0,
              reObserved: 0,
              events: new Set(),
              materialEvents: new Set(),
              primaryAttached: 0,
              origins: 0,
              derived: 0,
              unknown: 0,
            };
            statsBySource.set(i.source, s);
          }
          if (i.newVersion) s.newVersions++;
          else s.reObserved++;
          s.events.add(r.eventId);
          if (r.materialChanges > 0) s.materialEvents.add(r.eventId);
          if (i.primary) s.primaryAttached++;
          if (i.relation === "original") s.origins++;
          else if (i.relation && i.relation !== "unknown") s.derived++;
          else s.unknown++;
        }
      } catch (error) {
        failed++;
        console.warn(
          `persistCluster failed for "${c.title.slice(0, 60)}":`,
          error instanceof Error ? error.message : error,
        );
      }
      // heartbeat: remote runs are minute-scale per-cluster loops — a
      // periodic line is the difference between "slow" and "hung".
      const done = persisted + failed;
      if (done % 15 === 0)
        console.log(`persist: ${done}/${clusters.length} clusters`);
    }
    const resolved = await resolveStaleEvents().catch(() => 0);
    if (resolved > 0)
      console.log(`Event history: ${resolved} stale events resolved`);
    if (opts.sources?.length)
      await recordIngestCycle(opts.sources, statsBySource).catch((e) =>
        console.warn("ingest telemetry failed:", e),
      );
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock($1)", [PERSIST_LOCK_KEY])
      .catch(() => {});
    lockClient.release();
  }
  return { persisted, failed, eventIds };
}

/**
 * Coverage telemetry — one ingest_cycles row + one ingest_source_stats row
 * per source that reported in this cycle. The question it answers: does a
 * source add intelligence (new versions, material events, primary evidence)
 * or just volume?
 */
async function recordIngestCycle(
  sources: SourceStatus[],
  statsBySource: Map<
    string,
    {
      newVersions: number;
      reObserved: number;
      events: Set<string>;
      materialEvents: Set<string>;
      primaryAttached: number;
      origins: number;
      derived: number;
      unknown: number;
    }
  >,
): Promise<void> {
  const pool = getPool();
  const startedAt = sources
    .map((s) => s.checkedAt)
    .filter(Boolean)
    .sort()[0];
  const cyc = await pool.query<{ id: string }>(
    `INSERT INTO ingest_cycles (started_at) VALUES ($1) RETURNING id`,
    [startedAt ?? new Date().toISOString()],
  );
  const cycleId = cyc.rows[0].id;
  // batched unnest — ~100 sources × one insert each was pure RTT waste
  // over a remote pooler
  const stats = (s: SourceStatus) => {
    const ev = statsBySource.get(s.name);
    return {
      key: s.id,
      fetched: s.count,
      dup: ev?.reObserved ?? 0,
      newv: ev?.newVersions ?? 0,
      evs: ev?.events.size ?? 0,
      matev: ev?.materialEvents.size ?? 0,
      prim: ev?.primaryAttached ?? 0,
      lat: s.latencyMs ?? null,
      http: s.httpStatus ?? null,
      st: s.status,
      // information-lineage contribution: does the source bring new
      // origins or only derivative volume? syndicationRatio > ~0.5 is a
      // copy-forward outlet, not an intelligence source.
      detail: toJsonb({
        origins: ev?.origins ?? 0,
        derived: ev?.derived ?? 0,
        unknown: ev?.unknown ?? 0,
        syndicationRatio:
          (ev?.origins ?? 0) + (ev?.derived ?? 0)
            ? (ev?.derived ?? 0) / ((ev?.origins ?? 0) + (ev?.derived ?? 0))
            : null,
      }),
    };
  };
  const rows = sources.map(stats);
  await pool.query(
    `INSERT INTO ingest_source_stats
       (cycle_id, source_key, channel, provider, fetched, accepted,
        duplicate_docs, new_evidence_versions, events_contributed,
        material_events, primary_attached, latency_ms, http_status, status,
        detail)
     SELECT $1, t.key, NULL, NULL, t.fetched, t.fetched,
            t.dup, t.newv, t.evs, t.matev, t.prim, t.lat, t.http, t.st,
            t.detail::jsonb
     FROM unnest(
       $2::text[], $3::int[], $4::int[], $5::int[], $6::int[],
       $7::int[], $8::int[], $9::int[], $10::int[], $11::text[], $12::text[]
     ) AS t(key, fetched, dup, newv, evs, matev, prim, lat, http, st, detail)`,
    [
      cycleId,
      rows.map((r) => r.key),
      rows.map((r) => r.fetched),
      rows.map((r) => r.dup),
      rows.map((r) => r.newv),
      rows.map((r) => r.evs),
      rows.map((r) => r.matev),
      rows.map((r) => r.prim),
      rows.map((r) => r.lat),
      rows.map((r) => r.http),
      rows.map((r) => r.st),
      rows.map((r) => r.detail),
    ],
  );
}
