import { NextResponse } from "next/server";
import { getEdition } from "../../../lib/edition";
import {
  parseWatch,
  rankEdition,
  entitiesInEdition,
} from "../../../lib/relevance";

export const maxDuration = 60;

/**
 * Personal-mission scoring over the CURRENT edition — the heavy edition
 * build stays shared-cached; this is a pure re-rank per watch list.
 * `?e=fed,china&t=vietnam,world`
 */
export async function GET(req: Request) {
  const watch = parseWatch(new URL(req.url).searchParams);
  const edition = await getEdition();
  const ranked = rankEdition(edition, watch).slice(0, 30);
  return NextResponse.json(
    {
      clusters: ranked.map(({ cluster, relevance }) => ({
        id: cluster.id,
        title: cluster.title,
        score: relevance.score,
        matchedEntities: relevance.matchedEntities,
        topicMatch: relevance.topicMatch,
        leadUrl: cluster.leadArticle.url,
        publishedAt: cluster.publishedAt,
        significanceScore: cluster.significanceScore,
      })),
      availableEntities: entitiesInEdition(edition),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
