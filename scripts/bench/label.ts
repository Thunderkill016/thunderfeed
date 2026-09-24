/**
 * Interactive pair labeler — turns candidates into gold.
 *
 *   npm run bench:label
 *
 * Keys:  s = same event · d = different events · u = unsure (skip)
 *        Enter = accept suggestion · q = save & quit
 * Resume-safe: already-labeled pairs are skipped.
 */

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { BENCH_DIR, type EventPair } from "./shared";

const CANDIDATES = `${BENCH_DIR}/pairs.candidates.jsonl`;
const GOLD = `${BENCH_DIR}/pairs.jsonl`;

const load = (f: string): EventPair[] =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

function show(doc: EventPair["a"], tag: string) {
  const date = doc.publishedAt
    ? new Date(doc.publishedAt).toISOString().slice(0, 16).replace("T", " ")
    : "?";
  console.log(`  ${tag}  [${doc.source} · ${doc.language ?? "?"} · ${date}]`);
  console.log(`      ${doc.title}`);
  if (doc.summary) console.log(`      ${doc.summary.slice(0, 200)}`);
}

async function main() {
  const candidates = load(CANDIDATES);
  const done = new Set(load(GOLD).map((p) => p.id));
  const todo = candidates.filter((p) => !done.has(p.id));
  console.log(
    `${candidates.length} candidates · ${done.size} labeled · ${todo.length} to go\n`,
  );

  let i = 0;
  for (const p of todo) {
    i++;
    console.log(`── pair ${i}/${todo.length}  ${(p.trap ?? []).join(" ")}`);
    show(p.a, "A");
    show(p.b, "B");
    const hint = p.label === "same" ? "s" : "d";
    const ans = (await ask(`  same/diff/unsure [${hint}] or q: `))
      .trim()
      .toLowerCase();
    const pick = ans === "" ? hint : ans;
    if (pick === "q") break;
    if (pick !== "s" && pick !== "d") continue;
    const gold: EventPair = { ...p, label: pick === "s" ? "same" : "diff" };
    appendFileSync(GOLD, `${JSON.stringify(gold)}\n`);
  }
  rl.close();
  console.log(`\n${load(GOLD).length} gold pairs in bench/pairs.jsonl`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
