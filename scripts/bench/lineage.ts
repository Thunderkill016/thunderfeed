/**
 * Lineage corpus evaluator — deterministic classifier metrics.
 *
 * Labels (ground truth):
 *   syndicated | quoted | rewritten | press_release_based  → derived
 *   original                                             → confirmed independent
 *   unknown                                              → unresolved
 *
 * Three-way metrics per hardening spec:
 *   derived precision / recall / F1
 *   confirmed-independent precision   (original-label ⊆ predicted original)
 *   false-independent rate            (derived mislabeled as original — costly)
 *   false-syndication rate            (independent mislabeled as derived — costly)
 *   unknown rate                      (unresolved outputs — allowed to grow)
 *
 * Safety order enforced by gates: derived→unknown is acceptable,
 * derived→original and original→derived are not.
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

const path = process.argv[2] ?? "bench/lineage.jsonl";
const file = fileURLToPath(new URL(`../../${path}`, import.meta.url));
const cases: BenchCase[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let dTP = 0,
  dFP = 0,
  dFN = 0;
let oTP = 0,
  oFP = 0;
let falseIndep = 0,
  falseSynd = 0,
  labeledDerived = 0,
  labeledOriginal = 0,
  labeledUnknown = 0,
  predUnknown = 0,
  predDerived = 0,
  predOriginal = 0,
  relationOk = 0;
const misses: string[] = [];

for (const c of cases) {
  const got = classifyLineage(c.child, c.candidates);
  const wantDerived = DERIVED.has(c.label);
  const gotDerived = DERIVED.has(got.relation);
  const wantOrig = c.label === "original";
  const gotOrig = got.relation === "original";

  if (wantDerived) labeledDerived++;
  if (wantOrig) labeledOriginal++;
  if (c.label === "unknown") labeledUnknown++;
  if (gotDerived) predDerived++;
  if (gotOrig) predOriginal++;
  if (got.relation === "unknown") predUnknown++;

  if (wantDerived && gotDerived) dTP++;
  else if (!wantDerived && gotDerived) dFP++;
  else if (wantDerived && !gotDerived) dFN++;

  if (wantOrig && gotOrig) oTP++;
  else if (!wantOrig && gotOrig) oFP++;

  if (wantDerived && gotOrig) falseIndep++;
  if (wantOrig && gotDerived) falseSynd++;

  if (got.relation === c.label) relationOk++;
  if (got.relation !== c.label)
    misses.push(
      `${c.id} [${c.label} → ${got.relation}] ${c.note ?? ""}`.trim(),
    );
}

const precision = dTP + dFP ? dTP / (dTP + dFP) : 1;
const recall = dTP + dFN ? dTP / (dTP + dFN) : 1;
const f1 =
  precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
const origPrecision = oTP + oFP ? oTP / (oTP + oFP) : 1;
const falseIndepRate = labeledDerived ? falseIndep / labeledDerived : 0;
const falseSyndRate = labeledOriginal ? falseSynd / labeledOriginal : 0;
const unknownRate = cases.length ? predUnknown / cases.length : 0;

console.log(`corpus:           ${path}`);
console.log(`cases:            ${cases.length}`);
console.log(
  `labels:           derived=${labeledDerived} original=${labeledOriginal} unknown=${labeledUnknown}`,
);
console.log(
  `predicted:        derived=${predDerived} original=${predOriginal} unknown=${predUnknown}`,
);
console.log(`precision (der.): ${(precision * 100).toFixed(1)}%  (gate ≥95%)`);
console.log(`recall (der.):    ${(recall * 100).toFixed(1)}%`);
console.log(`F1:               ${(f1 * 100).toFixed(1)}%`);
console.log(
  `precision (orig): ${(origPrecision * 100).toFixed(1)}%  (gate ≥95%)`,
);
console.log(
  `false-independent: ${(falseIndepRate * 100).toFixed(1)}%  (gate <5%)`,
);
console.log(
  `false-syndication: ${(falseSyndRate * 100).toFixed(1)}%  (gate <2%)`,
);
console.log(`unknown rate:     ${(unknownRate * 100).toFixed(1)}%`);
console.log(`exact relation:   ${relationOk}/${cases.length}`);
if (misses.length) {
  console.log("\nmisses:");
  for (const m of misses) console.log(" ", m);
}

const fail =
  precision < 0.95 ||
  origPrecision < 0.95 ||
  falseIndepRate >= 0.05 ||
  falseSyndRate >= 0.02;
console.log(fail ? "\nBENCH: FAIL" : "\nBENCH: PASS");
process.exit(fail ? 1 : 0);
