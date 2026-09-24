/**
 * bench/lineage.jsonl evaluator — deterministic lineage classifier metrics.
 *
 * Labels (ground truth):
 *   syndicated | quoted | rewritten | press_release_based  → derived
 *   original                                             → independent
 *
 * Metrics per mission gates:
 *   syndication precision/recall/F1   (derived-class performance)
 *   false-independent rate            (derived labeled as original — costly)
 *   false-syndication rate            (original labeled as derived — costly)
 *   coverage                          (non-unknown classification rate)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyLineage,
  type LineageDoc,
  type LineageRelation,
} from "../../lib/lineage";

interface BenchCase {
  id: string;
  label: LineageRelation;
  note?: string;
  child: LineageDoc;
  candidates: LineageDoc[];
}

const DERIVED = new Set([
  "syndicated",
  "quoted",
  "rewritten",
  "press_release_based",
]);

const file = fileURLToPath(
  new URL("../../bench/lineage.jsonl", import.meta.url),
);
const cases: BenchCase[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let tp = 0,
  fp = 0,
  fn = 0,
  tn = 0,
  relationOk = 0,
  evaluated = 0;
const misses: string[] = [];

for (const c of cases) {
  const got = classifyLineage(c.child, c.candidates);
  const wantDerived = DERIVED.has(c.label);
  const gotDerived = DERIVED.has(got.relation);
  if (wantDerived && gotDerived) tp++;
  else if (!wantDerived && gotDerived) fp++;
  else if (wantDerived && !gotDerived) fn++;
  else tn++;
  if (got.relation === c.label) relationOk++;
  if (got.relation !== "unknown") evaluated++;
  if (wantDerived !== gotDerived || got.relation !== c.label) {
    misses.push(
      `${c.id} [${c.label} → ${got.relation}] ${c.note ?? ""}`.trim(),
    );
  }
}

const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const falseIndependent = fn / (fn + tp || 1); // derived missed → original
const falseSyndication = fp / (fp + tn || 1); // original → derived
const coverage = evaluated / cases.length;

console.log(`cases:            ${cases.length}`);
console.log(`precision (der.): ${(precision * 100).toFixed(1)}%  (gate ≥95%)`);
console.log(`recall (der.):    ${(recall * 100).toFixed(1)}%`);
console.log(`F1:               ${(f1 * 100).toFixed(1)}%`);
console.log(`false-independent: ${(falseIndependent * 100).toFixed(1)}%`);
console.log(`false-syndication: ${(falseSyndication * 100).toFixed(1)}%`);
console.log(`coverage:         ${(coverage * 100).toFixed(1)}%`);
console.log(`exact relation:   ${relationOk}/${cases.length}`);
if (misses.length) {
  console.log("\nmisses:");
  for (const m of misses) console.log(" ", m);
}
process.exit(precision >= 0.95 ? 0 : 1);
