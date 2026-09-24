/**
 * Mine candidate event pairs from the live evidence store.
 *
 *   same  — two docs attached to the same event (biased sample)
 *   diff  — two docs from different events, biased toward HARD cases:
 *           same topic, within 72h, shared generic claim key,
 *           or cross-language coverage.
 *
 * Output: bench/pairs.candidates.jsonl — feed to `npm run bench:label`.
 * Human labels become the gold set; suggestions are only a starting point.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { getPool } from "../../lib/db/pool";
import { extractClaims } from "../../lib/db/extract";
import {
  BENCH_DIR,
  docToCluster,
  detectLang,
  type BenchDoc,
  type EventPair,
} from "./shared";

const MAX_SAME_PER_EVENT = 6;
const MAX_SAME_TOTAL = 220;
const MAX_DIFF_PER_EVENT = 4;
const MAX_DIFF_TOTAL = 280;
const WINDOW_MS = 72 * 3600 * 1000;
const GENERIC = new Set([
  "deaths",
  "injured",
  "missing",
  "evacuated",
  "victims",
  "arrests",
  "flights_cancelled",
  "damage_vnd",
  "damage_usd",
  "money_vnd",
  "money_usd",
  "area_ha",
  "growth_pct",
  "sentence_years",
  "magnitude",
]);

interface Row extends BenchDoc {
  doc_id: string;
  event_id: string;
  observed_at: string;
}

async function main() {
  const pool = getPool();
  const { rows } = await pool.query<Row>(
    `SELECT d.id AS doc_id, ee.event_id,
            s.name AS source, ev.title, ev.summary,
            d.canonical_url AS url, d.published_at AS "publishedAt",
            e.topic, ev.observed_at
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents d ON d.id = ev.document_id
     JOIN sources s ON s.id = d.source_id
     JOIN events e ON e.id = ee.event_id
     WHERE ee.detached_at IS NULL
     ORDER BY ev.observed_at DESC`,
  );

  const byEvent = new Map<string, Row[]>();
  for (const r of rows) {
    r.language = detectLang(`${r.title} ${r.summary ?? ""}`);
    const list = byEvent.get(r.event_id) ?? [];
    list.push(r);
    byEvent.set(r.event_id, list);
  }
  const events = [...byEvent.values()];

  // generic claim keys per doc — the trap signal
  const claimKeys = new Map<string, Set<string>>();
  const keysFor = (r: Row) => {
    let k = claimKeys.get(r.doc_id);
    if (!k) {
      k = new Set(
        extractClaims(docToCluster(r)).map(
          (c) => c.claimKey.split("|").pop() ?? c.claimKey,
        ),
      );
      claimKeys.set(r.doc_id, k);
    }
    return k;
  };

  const pairs: EventPair[] = [];
  const seen = new Set<string>();
  const push = (a: Row, b: Row, suggest: "same" | "diff", trap: string[]) => {
    const key = [a.doc_id, b.doc_id].sort().join("|");
    if (seen.has(key) || a.doc_id === b.doc_id) return;
    seen.add(key);
    pairs.push({
      id: key,
      a: strip(a),
      b: strip(b),
      label: suggest,
      trap,
    });
  };

  // same-event pairs
  let same = 0;
  for (const docs of events) {
    for (let i = 0; i < docs.length && same < MAX_SAME_TOTAL; i++)
      for (
        let j = i + 1;
        j < docs.length && j <= i + MAX_SAME_PER_EVENT && same < MAX_SAME_TOTAL;
        j++
      ) {
        const trap: string[] = [];
        if (docs[i].language !== docs[j].language) trap.push("cross-lang");
        if (docs[i].source === docs[j].source) trap.push("same-source");
        push(docs[i], docs[j], "same", trap);
        same++;
      }
  }

  // different-event pairs — hard-biased
  let diff = 0;
  for (let x = 0; x < events.length && diff < MAX_DIFF_TOTAL; x++) {
    let used = 0;
    for (let y = x + 1; y < events.length && used < MAX_DIFF_PER_EVENT; y++) {
      for (const a of events[x].slice(0, 2)) {
        if (diff >= MAX_DIFF_TOTAL || used >= MAX_DIFF_PER_EVENT) break;
        for (const b of events[y].slice(0, 2)) {
          const dt =
            Math.abs(
              Date.parse(a.publishedAt ?? a.observed_at) -
                Date.parse(b.publishedAt ?? b.observed_at),
            ) <= WINDOW_MS;
          if (!dt || a.topic !== b.topic) continue;
          const trap: string[] = [];
          const shared = [...keysFor(a)].filter((k) => keysFor(b).has(k));
          const sharedGeneric = shared.filter((k) => GENERIC.has(k));
          if (sharedGeneric.length) trap.push(`generic:${sharedGeneric[0]}`);
          else if (shared.length) trap.push(`claim:${shared[0]}`);
          if (a.language !== b.language) trap.push("cross-lang");
          if (a.source === b.source) trap.push("same-source");
          // prefer pairs carrying SOME signal; keep a few same-topic baseline
          if (trap.length === 0 && used > 0) continue;
          push(a, b, "diff", trap.length ? trap : ["baseline"]);
          used++;
          diff++;
        }
      }
    }
  }

  writeFileSync(`${BENCH_DIR}/pairs.candidates.jsonl`, "");
  for (const p of pairs)
    appendFileSync(
      `${BENCH_DIR}/pairs.candidates.jsonl`,
      `${JSON.stringify(p)}\n`,
    );

  const stats = { same, diff, events: events.length, docs: rows.length };
  console.log(
    `mined ${pairs.length} candidate pairs → bench/pairs.candidates.jsonl`,
  );
  console.log(JSON.stringify(stats));
  console.log(
    `traps: ${pairs.filter((p) => p.trap?.some((t) => t.startsWith("generic:"))).length} generic-claim, ` +
      `${pairs.filter((p) => p.trap?.includes("cross-lang")).length} cross-lang`,
  );
  process.exit(0);
}

const strip = (r: Row): BenchDoc => ({
  source: r.source,
  title: r.title,
  summary: r.summary ?? "",
  url: r.url,
  language: r.language,
  topic: r.topic,
  publishedAt: r.publishedAt ?? r.observed_at,
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
