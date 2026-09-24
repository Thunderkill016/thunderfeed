/**
 * Bridge between the news refresh pipeline and the append-only store.
 * refreshNews() produces deduplicated articles; this turns the top
 * clusters into Evidence → Event → Claim → Change history.
 * Inert without DATABASE_URL — persistence is optional, like the cache.
 */

import type { StoryCluster } from "../model";
import type { Feed } from "../feeds";
import { dbEnabled } from "./pool";
import { extractClaims } from "./extract";
import { persistCluster, resolveStaleEvents, type SourceMeta } from "./writer";

/* Bound DB growth per refresh: only the most significant clusters persist.
   60 clusters × ~3 evidence versions stays well under free-tier write
   budgets while covering the whole front page. */
const PERSIST_TOP_CLUSTERS = 60;

function metaFor(feed: Feed | undefined, name: string): SourceMeta {
  if (name === "Hacker News")
    return {
      kind: "community",
      region: "global",
      language: "en",
      channel: "hn",
    };
  return {
    kind: "publisher",
    region: feed?.region === "vietnam" ? "vietnam" : "global",
    language: feed?.language,
    channel: "rss",
  };
}

/**
 * Persist one edition build. Callers pass the FINAL clusters (post
 * semantic-merge) so persisted events match what the UI renders.
 * Each cluster commits independently — one bad cluster must not
 * sink the edition (transactional isolation).
 */
export async function persistEdition(
  allClusters: StoryCluster[],
  feedByName: Map<string, Feed>,
): Promise<{ persisted: number; failed: number }> {
  if (!dbEnabled() || allClusters.length === 0)
    return { persisted: 0, failed: 0 };

  const clusters = [...allClusters]
    .sort((a, b) => b.significanceScore - a.significanceScore)
    .slice(0, PERSIST_TOP_CLUSTERS);

  const sourceMeta: Record<string, SourceMeta> = {};
  for (const c of clusters)
    for (const a of c.articles)
      sourceMeta[a.source] ??= metaFor(feedByName.get(a.source), a.source);

  let persisted = 0;
  let failed = 0;
  for (const c of clusters) {
    try {
      await persistCluster(c, extractClaims(c), {
        channel: "rss",
        sourceMeta,
      });
      persisted++;
    } catch (error) {
      failed++;
      console.warn(
        `persistCluster failed for "${c.title.slice(0, 60)}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  const resolved = await resolveStaleEvents().catch(() => 0);
  if (resolved > 0)
    console.log(`Event history: ${resolved} stale events resolved`);
  return { persisted, failed };
}
