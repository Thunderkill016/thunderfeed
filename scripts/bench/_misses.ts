import { setupBenchDb, docToCluster, readJsonl } from "./shared";
import type { EventPair } from "./shared";
import { persistCluster } from "../../lib/db/writer";
import { extractClaims } from "../../lib/db/extract";

async function main() {
  const misses: string[] = [];
  for (const p of readJsonl<EventPair>("pairs.jsonl")) {
    setupBenchDb();
    const a = docToCluster(p.a);
    const b = docToCluster(p.b);
    const ra = await persistCluster(a, extractClaims(a));
    const rb = await persistCluster(b, extractClaims(b));
    const merged = ra.eventId === rb.eventId;
    if ((p.label === "same") !== merged) {
      misses.push(
        `${p.label}→${merged ? "WMERGE" : "SPLIT"}  ${p.a.title.slice(0, 52)} ⇄ ${p.b.title.slice(0, 52)}`,
      );
    }
  }
  console.log(misses.join("\n"));
  console.log(`\nTOTAL ${misses.length}`);
}
main();
