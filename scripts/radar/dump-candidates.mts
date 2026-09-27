/* Dump real radar candidates (deltas + events) from the DB into the
 * labeled-corpus fixture shell — the bench in bench.mts scores rankings
 * against the human labels that get filled in afterwards.
 *
 *   npx tsx scripts/radar/dump-candidates.mts > corpus-raw.json
 */
import { getLatestDataDeltas, getRecentEvents } from "../../lib/db/read.ts";

const deltas = await getLatestDataDeltas(60);
const events = await getRecentEvents(120);
process.stdout.write(
  JSON.stringify(
    {
      dumpedAt: new Date().toISOString(),
      deltas,
      events,
    },
    null,
    2,
  ) + "\n",
);
process.exit(0);
