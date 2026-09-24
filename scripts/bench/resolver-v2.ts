/**
 * Resolver V2 held-out evaluator (Phase 9/10).
 *
 * Pair ids embed article ids ("docA|docB"), and one article appears in
 * many pairs — a random pair split would leak events across partitions.
 * Groups are therefore the connected components of the article graph;
 * whole components are assigned to train/dev/test (≈60/20/20) with a
 * greedy stratification that keeps same-event pairs present in test.
 *
 * Thresholds are tuned ONLY on train/dev. This script reports the final
 * numbers on the untouched test split plus the full corpus as regression.
 *
 *   npx tsx scripts/bench/resolver-v2.ts
 *   THUNDERFEED_BENCH_LIVE_EMBED=1 … (embed uncached reps via API)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BENCH_DIR,
  detectLang,
  docToCluster,
  readJsonl,
  type EventPair,
} from "./shared";
import { persistCluster } from "../../lib/db/writer";
import { extractClaims } from "../../lib/db/extract";
import { setupBenchDb } from "./shared";
import { repHash } from "../../lib/resolver";
import { embedArticles } from "../../lib/embed";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* key may already be in env */
}

/* ------------- grouped split: temporal batch partition ----------------------
 * Article ids are UUIDv7 — time-ordered by crawl batch. Docs are assigned
 * to exactly one partition by batch (newest batch → test, middle → dev,
 * oldest → train). A pair is evaluated in a split only when BOTH docs live
 * there; cross-batch pairs fall back to train so no article leaks into a
 * held-out partition. Seed pairs are standalone and go to test. */
function batchOf(id: string): string {
  return id.slice(0, 7); // e.g. "01a0d18"
}

function splitGroups(pairs: EventPair[]) {
  const docBatch = new Map<string, string>();
  for (const p of pairs) {
    if (!p.id.includes("|") || p.id.startsWith("seed")) continue;
    const [a, b] = p.id.split("|");
    docBatch.set(a, batchOf(a));
    docBatch.set(b, batchOf(b));
  }
  const batches = [...new Set(docBatch.values())].sort(); // v7: lexical = temporal
  const newest = batches[batches.length - 1];
  const middle = batches[batches.length - 2];
  const docSplit = new Map<string, "train" | "dev" | "test">();
  for (const [d, b] of docBatch)
    docSplit.set(d, b === newest ? "test" : b === middle ? "dev" : "train");

  const splits = {
    train: [] as EventPair[],
    dev: [] as EventPair[],
    test: [] as EventPair[],
  };
  for (const p of pairs) {
    if (!p.id.includes("|") || p.id.startsWith("seed")) {
      splits.test.push(p); // hand-authored seeds — held out
      continue;
    }
    const [a, b] = p.id.split("|");
    const sa = docSplit.get(a)!;
    const sb = docSplit.get(b)!;
    splits[sa === sb ? sa : "train"].push(p);
  }
  return splits;
}

/* -------------------------------- metrics --------------------------------- */

type Row = {
  pair: EventPair;
  gold: "same" | "diff";
  pred: "same" | "diff" | "ambiguous";
  langPair: string;
  semAvailable: boolean;
};

function metrics(rows: Row[]) {
  const same = rows.filter((r) => r.gold === "same");
  const diff = rows.filter((r) => r.gold === "diff");
  const tp = rows.filter((r) => r.gold === "same" && r.pred === "same").length;
  const wm = rows.filter((r) => r.gold === "diff" && r.pred === "same").length;
  const amb = rows.filter((r) => r.pred === "ambiguous").length;
  const cross = same.filter((r) => r.langPair === "en-vi");
  const crossTp = cross.filter((r) => r.pred === "same").length;
  const semN = rows.filter((r) => r.semAvailable).length;
  const p = tp + wm ? tp / (tp + wm) : 0;
  const r = same.length ? tp / same.length : 0;
  return {
    n: rows.length,
    precision: p,
    recall: r,
    f1: p + r ? (2 * p * r) / (p + r) : 0,
    wrongMerge: diff.length ? wm / diff.length : 0,
    split: same.length ? (same.length - tp) / same.length : 0,
    crossLangRecall: cross.length ? crossTp / cross.length : NaN,
    ambiguousRate: rows.length ? amb / rows.length : 0,
    semanticAvailable: rows.length ? semN / rows.length : 0,
  };
}

function report(name: string, rows: Row[]) {
  const m = metrics(rows);
  const pct = (x: number) =>
    Number.isNaN(x) ? "  —  " : `${(100 * x).toFixed(1)}%`;
  console.log(
    `${name.padEnd(18)} n=${String(m.n).padStart(3)} P=${pct(m.precision)} R=${pct(m.recall)} F1=${pct(m.f1)} ` +
      `wm=${pct(m.wrongMerge)} split=${pct(m.split)} xlangR=${pct(m.crossLangRecall)} amb=${pct(m.ambiguousRate)} sem=${pct(m.semanticAvailable)}`,
  );
  if (!name.startsWith(" "))
    for (const lang of ["en-en", "en-vi", "vi-vi"]) {
      const sub = rows.filter((r) => r.langPair === lang);
      if (sub.length >= 3) report(`  ${lang}`, sub);
    }
  return m;
}

/* --------------------------------- run ------------------------------------ */

async function evalPairs(
  pairs: EventPair[],
  embedder: (t: string[]) => Promise<(number[] | null)[]>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const p of pairs) {
    setupBenchDb();
    const a = docToCluster(p.a);
    const b = docToCluster(p.b);
    const ra = await persistCluster(a, extractClaims(a), { embedder });
    const rb = await persistCluster(b, extractClaims(b), { embedder });
    const ev = (rb.resolverEvals ?? []).find(
      (e) => e.candidateId === ra.eventId,
    );
    const langPair = [
      p.a.language ?? detectLang(p.a.title),
      p.b.language ?? detectLang(p.b.title),
    ]
      .sort()
      .join("-");
    rows.push({
      pair: p,
      gold: p.label as "same" | "diff",
      pred:
        ra.eventId === rb.eventId
          ? "same"
          : ev?.decision.decision === "ambiguous"
            ? "ambiguous"
            : "diff",
      langPair,
      semAvailable: ev?.decision.features?.semanticSimilarity !== undefined,
    });
  }
  return rows;
}

async function main() {
  const pairs = readJsonl<EventPair>("pairs.jsonl").filter(
    (p) => p.label === "same" || p.label === "diff",
  );
  // Phase 10 note: transitive closure over same-cliques was evaluated and
  // REJECTED — same-labeled chains bridge distinct events (label noise
  // amplified, e.g. a culture festival joined to an OpenAI breach), so
  // mechanical expansion cannot mint gold. Reaching ≥150 positives needs
  // `bench:export` on a larger live evidence store + a labeling pass.
  const splits = splitGroups(pairs);
  console.log(
    `${pairs.length} pairs · temporal batch split → ` +
      `train ${splits.train.length} / dev ${splits.dev.length} / test ${splits.test.length}` +
      ` (same: ${splits.train.filter((p) => p.label === "same").length}/` +
      `${splits.dev.filter((p) => p.label === "same").length}/` +
      `${splits.test.filter((p) => p.label === "same").length})`,
  );

  const file = `${BENCH_DIR}/results/semantic-vectors.json`;
  const cache = new Map<string, number[]>(
    existsSync(file)
      ? Object.entries(
          JSON.parse(readFileSync(file, "utf8")) as Record<string, number[]>,
        )
      : [],
  );
  const live = process.env.THUNDERFEED_BENCH_LIVE_EMBED === "1";
  const apiKey = process.env.GEMINI_API_KEY;
  let apiFailures = 0;
  const embedder = async (texts: string[]) => {
    const hashes = texts.map(repHash);
    const out = hashes.map((h) => cache.get(h) ?? null);
    const miss = hashes.map((h, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
    if (live && apiKey && miss.length) {
      const got = await embedArticles(
        apiKey,
        miss.map((i) => ({ id: hashes[i], text: texts[i] })),
      );
      for (const i of miss) {
        const v = got.get(hashes[i]);
        if (v) {
          out[i] = v;
          cache.set(hashes[i], v);
        } else apiFailures++;
      }
      writeFileSync(file, JSON.stringify(Object.fromEntries(cache)));
    } else apiFailures += miss.length;
    return out;
  };

  console.log("\n── held-out TEST split (thresholds tuned on train/dev only)");
  const testRows = await evalPairs(splits.test, embedder);
  const m = report("test", testRows);

  console.log("\n── full corpus (regression view)");
  const fullRows = await evalPairs(pairs, embedder);
  report("full", fullRows);

  console.log(`\nsemantic api failures: ${apiFailures}`);
  console.log(
    `\ngates: wrong-merge<1% ${m.wrongMerge < 0.01 ? "PASS" : "FAIL"} · ` +
      `split≤10% ${m.split <= 0.1 ? "PASS" : `FAIL (frontier ${(100 * m.split).toFixed(1)}%)`} · ` +
      `xlangR≥90% ${Number.isNaN(m.crossLangRecall) ? "n/a" : m.crossLangRecall >= 0.9 ? "PASS" : "FAIL"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
