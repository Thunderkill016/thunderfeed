/* R7.0 — Materiality bench: scores the frozen corpus with the deterministic
 * baseline (lib/materiality.ts) and compares to the label fixture.
 *
 *   npx tsx scripts/materiality/bench.mts
 *
 * Metrics (per the R7.0 spec):
 *   materiality precision      — exact + within-1-rank agreement on labels
 *   systemic false-positive    — baseline 'major'+'systemic' whose label < major
 *   channel accuracy           — mean IoU of predicted vs labeled channel sets
 *   affected-target precision  — |pred ∩ label| / |pred| over predicted targets
 *   unsupported-causality      — predictions asserting channels/direction where
 *                                labels say none (incl. market_move channel
 *                                assertions — a move proves reaction, not cause)
 */
import { readFileSync } from "node:fs";
import {
  scoreCorporateAction,
  scoreEventMateriality,
  scoreMacroDelta,
  scoreMarketMove,
  type MaterialityAssessment,
} from "../../lib/materiality.ts";

const corpusPath = "tests/fixtures/materiality-corpus.json";
const labelsPath = "tests/fixtures/materiality-labels.json";
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const labels = JSON.parse(readFileSync(labelsPath, "utf8")).labels;

const RANK = ["none", "limited", "meaningful", "major", "systemic"];
const MATERIAL = RANK.indexOf("meaningful");
const rank = (m: string) => (m === "unknown" ? -1 : RANK.indexOf(m));

function rescore(item: any): MaterialityAssessment {
  const s = item.subject;
  switch (item.kind) {
    case "event":
      return scoreEventMateriality({
        predicates: s.predicates,
        entityTypes: s.entityTypes,
        entitySlugs: s.entitySlugs,
        topic: s.topic,
      });
    case "macro_release":
    case "macro_revision":
      return scoreMacroDelta({
        provider: s.provider,
        seriesCode: s.seriesCode,
        frequency: s.frequency,
        kind: item.kind,
        value: s.value,
        prevValue: s.prevValue,
        history: s.history ?? [],
      });
    case "corporate_action":
      return scoreCorporateAction({
        actionType: s.actionType,
        instrumentKey: s.instrumentKey,
        cashAmount: s.cashAmount,
        currency: s.currency,
        referencePrice: s.referencePrice,
        splitFactor: s.splitFactor,
      });
    case "market_move":
      return scoreMarketMove({
        instrumentKey: s.instrumentKey,
        assetClass: s.assetClass,
        pctChange: s.pctChange,
        trailingVol: s.z != null ? Math.abs(s.pctChange / s.z) : null,
        isIndex: s.assetClass === "index",
      });
    default:
      throw new Error(`unknown kind ${item.kind}`);
  }
}

let n = 0;
let exact = 0;
let within1 = 0;
let sysPred = 0;
let sysFP = 0;
let matTP = 0;
let matFP = 0;
let matFN = 0;
let chanIoUSum = 0;
let chanN = 0;
let tgtTP = 0;
let tgtPred = 0;
let causalN = 0;
let causalBad = 0;
const misses: string[] = [];

for (const item of corpus.items) {
  const label = labels[`${item.kind}:${item.id}`];
  if (!label) continue;
  n++;
  const pred = rescore(item);
  const lr = rank(label.intrinsicMateriality);
  const pr = rank(pred.materiality);
  if (pr === lr) exact++;
  if (pr >= 0 && Math.abs(pr - lr) <= 1) within1++;
  if (pr >= RANK.indexOf("major")) {
    sysPred++;
    if (lr < RANK.indexOf("major")) {
      sysFP++;
      misses.push(
        `SYSFP ${item.kind}:${item.id.slice(0, 8)} pred=${pred.materiality} label=${label.intrinsicMateriality} — ${item.title.slice(0, 60)}`,
      );
    }
  }
  if (pr >= MATERIAL) {
    if (lr >= MATERIAL) matTP++;
    else matFP++;
  } else if (lr >= MATERIAL) matFN++;
  if (label.channels.length || pred.channels.length) {
    const inter = pred.channels.filter((c) =>
      label.channels.includes(c),
    ).length;
    const union = new Set([...pred.channels, ...label.channels]).size;
    chanIoUSum += union ? inter / union : 1;
    chanN++;
  }
  if (pred.affectedTargets.length) {
    tgtPred += pred.affectedTargets.length;
    tgtTP += pred.affectedTargets.filter((t) =>
      label.affectedTargets.includes(t),
    ).length;
  }
  /* unsupported causality: asserting an economic channel where the label
   * says none exists, or ANY channel on a market_move (reaction ≠ cause) */
  causalN++;
  if (
    (item.kind === "market_move" && pred.channels.length > 0) ||
    (label.channels.length === 0 &&
      pred.channels.length > 0 &&
      lr <= RANK.indexOf("limited"))
  ) {
    causalBad++;
    misses.push(
      `CAUSAL ${item.kind}:${item.id.slice(0, 8)} pred=${pred.materiality}[${pred.channels}] label=${label.intrinsicMateriality} — ${item.title.slice(0, 55)}`,
    );
  }
}

console.log(`labeled items scored: ${n} / ${corpus.items.length}`);
console.log(`\nmateriality precision`);
console.log(`  exact           ${(exact / n).toFixed(3)}`);
console.log(`  within-1-rank   ${(within1 / n).toFixed(3)}`);
console.log(
  `  'material' flag precision ${(matTP / Math.max(1, matTP + matFP)).toFixed(3)}` +
    `  recall ${(matTP / Math.max(1, matTP + matFN)).toFixed(3)}`,
);
console.log(`\nsystemic false-positive rate`);
console.log(
  `  ${sysFP}/${sysPred} = ${sysPred ? (sysFP / sysPred).toFixed(3) : "n/a (no major+ predictions)"}`,
);
console.log(`\nchannel accuracy (mean IoU, n=${chanN})`);
console.log(`  ${(chanIoUSum / Math.max(1, chanN)).toFixed(3)}`);
console.log(`\naffected-target precision`);
console.log(
  `  ${tgtTP}/${tgtPred} = ${tgtPred ? (tgtTP / tgtPred).toFixed(3) : "n/a"}`,
);
console.log(`\nunsupported-causality rate`);
console.log(`  ${causalBad}/${causalN} = ${(causalBad / causalN).toFixed(3)}`);

if (misses.length) {
  console.log(`\n--- disagreements (${misses.length}) ---`);
  for (const m of misses.slice(0, 40)) console.log(" ", m);
}
