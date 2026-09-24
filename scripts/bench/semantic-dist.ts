/**
 * Phase 11 — semantic similarity distribution measurement.
 *
 * Embeds every pair side's event representation (title + summary + entity
 * slugs + claim labels — the same bounded recipe the persistent resolver
 * uses) and reports cosine percentiles per stratum:
 *   same-event overall · same cross-language · diff overall ·
 *   diff same-topic traps · diff cross-language
 *
 * Threshold bands are chosen FROM this table — never copied from the
 * clustering layer. Run: npx tsx scripts/bench/semantic-dist.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  BENCH_DIR,
  detectLang,
  docToCluster,
  readJsonl,
  type EventPair,
} from "./shared";
import { embedArticles, cosine, embedModel } from "../../lib/embed";
import { clusterRepTextV2, repHash } from "../../lib/resolver";
import { extractClaims } from "../../lib/db/extract";

// no dotenv dep — read .env.local ourselves for the bench key
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* key may already be in env */
}

const VEC_CACHE = `${BENCH_DIR}/results/semantic-vectors.json`;
const OUT = `${BENCH_DIR}/results/semantic-dist.json`;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function stats(name: string, v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return {
    name,
    n: s.length,
    min: s[0] ?? 0,
    p05: percentile(s, 5),
    p10: percentile(s, 10),
    p25: percentile(s, 25),
    p50: percentile(s, 50),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    max: s[s.length - 1] ?? 0,
  };
}

async function main() {
  const pairs = readJsonl<EventPair>("pairs.jsonl").filter(
    (p) => p.label === "same" || p.label === "diff",
  );
  console.log(`${pairs.length} labeled pairs`);

  // one repText per unique side (dedupe by repHash)
  const reps = new Map<string, { hash: string; text: string }>();
  const sideHash = new Map<string, string>();
  for (const p of pairs) {
    for (const [key, d] of [
      [`${p.id}|a`, p.a],
      [`${p.id}|b`, p.b],
    ] as const) {
      const c = docToCluster(d);
      const text = clusterRepTextV2(c, extractClaims(c));
      const hash = repHash(text);
      reps.set(hash, { hash, text });
      sideHash.set(key, hash);
    }
  }
  console.log(`${reps.size} unique representations`);

  // embed — disk cache keyed by repHash so re-runs cost nothing
  let vectors = new Map<string, number[]>();
  const apiKey = process.env.GEMINI_API_KEY;
  let apiFailures = 0;
  if (existsSync(VEC_CACHE)) {
    const raw = JSON.parse(readFileSync(VEC_CACHE, "utf8")) as Record<
      string,
      number[]
    >;
    for (const [k, v] of Object.entries(raw)) vectors.set(k, v);
  }
  const missing = [...reps.values()].filter((r) => !vectors.has(r.hash));
  if (apiKey && missing.length) {
    console.log(`embedding ${missing.length} missing vectors…`);
    const got = await embedArticles(
      apiKey,
      missing.map((r) => ({ id: r.hash, text: r.text })),
    );
    for (const [k, v] of got) vectors.set(k, v);
    apiFailures = missing.length - got.size;
    mkdirSync(`${BENCH_DIR}/results`, { recursive: true });
    writeFileSync(VEC_CACHE, JSON.stringify(Object.fromEntries(vectors)));
  }
  const available = [...reps.keys()].filter((h) => vectors.has(h)).length;
  console.log(
    `vectors: ${available}/${reps.size} (api failures: ${apiFailures}, model ${embedModel()})`,
  );

  // per-pair cosine
  type Row = {
    id: string;
    gold: "same" | "diff";
    langPair: string;
    crossLang: boolean;
    traps: string[];
    cosine: number | null;
  };
  const rows: Row[] = pairs.map((p) => {
    const la = p.a.language ?? detectLang(p.a.title);
    const lb = p.b.language ?? detectLang(p.b.title);
    const va = vectors.get(sideHash.get(`${p.id}|a`)!);
    const vb = vectors.get(sideHash.get(`${p.id}|b`)!);
    return {
      id: p.id,
      gold: p.label as "same" | "diff",
      langPair: [la, lb].sort().join("-"),
      crossLang: la !== lb,
      traps: p.trap ?? [],
      cosine: va && vb ? cosine(va, vb) : null,
    };
  });

  const withVec = rows.filter((r) => r.cosine !== null);
  const same = withVec.filter((r) => r.gold === "same");
  const diff = withVec.filter((r) => r.gold === "diff");
  const sameCross = same.filter((r) => r.crossLang);
  const diffSameTopic = diff.filter((r) =>
    r.traps.some((t) => t === "same-topic" || t === "entity-collision"),
  );
  const diffCross = diff.filter((r) => r.crossLang);
  const diffSameSource = diff.filter(
    (r) => !r.crossLang && r.traps.includes("same-source"),
  );

  const table = [
    stats(
      "same/all",
      same.map((r) => r.cosine!),
    ),
    stats(
      "same/cross-lang",
      sameCross.map((r) => r.cosine!),
    ),
    stats(
      "diff/all",
      diff.map((r) => r.cosine!),
    ),
    stats(
      "diff/same-topic",
      diffSameTopic.map((r) => r.cosine!),
    ),
    stats(
      "diff/cross-lang",
      diffCross.map((r) => r.cosine!),
    ),
    stats(
      "diff/same-source",
      diffSameSource.map((r) => r.cosine!),
    ),
  ];

  console.log("\ncosine distribution (percentiles):");
  console.log(
    "stratum".padEnd(20) +
      "n".padStart(5) +
      ["p05", "p10", "p25", "p50", "p75", "p90", "p95", "max"]
        .map((h) => h.padStart(7))
        .join(""),
  );
  for (const t of table) {
    console.log(
      t.name.padEnd(20) +
        String(t.n).padStart(5) +
        [t.p05, t.p10, t.p25, t.p50, t.p75, t.p90, t.p95, t.max]
          .map((x) => x.toFixed(3).padStart(7))
          .join(""),
    );
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        model: embedModel(),
        semanticAvailable: available / reps.size,
        apiFailures,
        table,
        rows: rows.map((r) => ({
          id: r.id,
          gold: r.gold,
          langPair: r.langPair,
          crossLang: r.crossLang,
          cosine: r.cosine,
        })),
      },
      null,
      1,
    ),
  );
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
