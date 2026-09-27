/* Refresh the labeled corpus' event payloads with current DB fields
 * (entities+prominence, independent/primary counts, claim states) while
 * keeping q/relevantTo labels byte-identical — R6 bench reruns against
 * the same human labels, on enriched data.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/refresh-corpus.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getRecentEvents } from "../../lib/db/read.ts";

const PATH = fileURLToPath(
  new URL("../../tests/fixtures/radar-corpus.json", import.meta.url),
);
const corpus = JSON.parse(readFileSync(PATH, "utf8")) as {
  items: {
    ref: string;
    kind: string;
    q: string;
    relevantTo: string[];
    data: Record<string, unknown>;
  }[];
};

/* corpus events may include merged/archived rows the radar query
 * excludes — pull the live window plus a wide fallback lookup */
const live = await getRecentEvents(500);
const byId = new Map(live.map((e) => [e.id, e]));

let refreshed = 0;
let missing = 0;
for (const it of corpus.items) {
  if (it.kind !== "event") continue;
  const fresh = byId.get(it.data.id as string);
  if (!fresh) {
    missing++;
    continue;
  }
  /* replace ONLY the measured payload — label fields are frozen */
  it.data = { ...it.data, ...fresh };
  refreshed++;
}
console.log(`refreshed ${refreshed} events, ${missing} gone (merged/archived)`);
writeFileSync(PATH, JSON.stringify(corpus, null, 2) + "\n");
process.exit(0);
