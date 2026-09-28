/* R7.0b — Materiality bench: scores the frozen corpus (and the challenge
 * set, if present) with the deterministic baseline and compares to labels.
 *
 *   npx tsx scripts/materiality/bench.mts
 *
 * Metrics:
 *   coverage / abstention     — how often the engine abstains ('unknown')
 *   classified accuracy       — exact / within-1-rank on NON-abstained preds
 *   overall accuracy          — same over all labeled items
 *   confusion matrix          — label × pred
 *   'material' flag P/R/F1    — meaningful-or-higher boundary
 *   high-impact FP            — 'major'+'systemic' preds whose label < major
 *   channel IoU               — per kind AND overall (never hide kind gaps)
 *   target P / R / F1         — typed affectedTargets, stringified
 *   unsupported-causality     — channels asserted where labels say none
 *
 * holdout vs challenge sets are reported SEPARATELY — a curated crisis
 * case must never count against the live distribution.
 */
import { readFileSync } from "node:fs";
import {
  scoreCorporateAction,
  scoreEventMateriality,
  scoreMacroDelta,
  scoreMarketMove,
  type MaterialityAssessment,
  type Target,
} from "../../lib/materiality.ts";

const RANK = ["none", "limited", "meaningful", "major", "systemic"];
const MATERIAL = RANK.indexOf("meaningful");
const rank = (m: string) => (m === "unknown" ? -1 : RANK.indexOf(m));
const tkey = (t: Target | string) =>
  typeof t === "string" ? t : `${t.type}:${t.key}`;

interface LabelEntry {
  intrinsicMateriality: string;
  channels: string[];
  affectedTargets: (Target | string)[];
  labeled_by?: string;
  reviewed?: boolean;
}

interface Item {
  kind: string;
  id: string;
  title: string;
  sourceSet?: string;
  subject: any;
}

function rescore(item: Item): MaterialityAssessment {
  const s = item.subject;
  switch (item.kind) {
    case "event":
      return scoreEventMateriality({
        predicates: s.predicates,
        entities: s.entities ?? [],
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
        priceBasis: s.priceBasis ?? "none",
        exDate: s.exDate ?? null,
        splitFactor: s.splitFactor,
      });
    case "market_move":
      return scoreMarketMove({
        instrumentKey: s.instrumentKey,
        assetClass: s.assetClass,
        pctChange: s.pctChange,
        trailingVol:
          s.trailingVol !== undefined
            ? s.trailingVol
            : s.z != null
              ? Math.abs(s.pctChange / s.z)
              : null,
        isIndex: s.assetClass === "index",
      });
    default:
      throw new Error(`unknown kind ${item.kind}`);
  }
}

const blank = () => ({
  n: 0,
  abstained: 0,
  exact: 0,
  within1: 0,
  classExact: 0,
  classN: 0,
  matTP: 0,
  matFP: 0,
  matFN: 0,
  hiPred: 0,
  hiFP: 0,
  chanIoUSum: 0,
  chanN: 0,
  chanByKind: new Map<string, { sum: number; n: number }>(),
  tgtTP: 0,
  tgtPred: 0,
  tgtGold: 0,
  causalN: 0,
  causalBad: 0,
  confusion: new Map<string, Map<string, number>>(),
  misses: [] as string[],
});
type Stats = ReturnType<typeof blank>;

function accumulate(item: Item, label: LabelEntry, st: Stats) {
  st.n++;
  const pred = rescore(item);
  const lr = rank(label.intrinsicMateriality);
  const pr = rank(pred.materiality);
  if (pr === -1) st.abstained++;
  else {
    st.classN++;
    if (pr === lr) st.classExact++;
  }
  if (pr === lr) st.exact++;
  if (pr >= 0 && Math.abs(pr - lr) <= 1) st.within1++;
  const row = st.confusion.get(label.intrinsicMateriality) ?? new Map();
  row.set(pred.materiality, (row.get(pred.materiality) ?? 0) + 1);
  st.confusion.set(label.intrinsicMateriality, row);
  if (pr >= RANK.indexOf("major")) {
    st.hiPred++;
    if (lr < RANK.indexOf("major")) {
      st.hiFP++;
      st.misses.push(
        `HIFP ${item.kind}:${item.id.slice(0, 8)} pred=${pred.materiality} label=${label.intrinsicMateriality} — ${item.title.slice(0, 60)}`,
      );
    }
  }
  if (pr >= MATERIAL) {
    if (lr >= MATERIAL) st.matTP++;
    else st.matFP++;
  } else if (lr >= MATERIAL) st.matFN++;
  if (label.channels.length || pred.channels.length) {
    const inter = pred.channels.filter((c) =>
      label.channels.includes(c),
    ).length;
    const union = new Set([...pred.channels, ...label.channels]).size;
    st.chanIoUSum += union ? inter / union : 1;
    st.chanN++;
    const k = st.chanByKind.get(item.kind) ?? { sum: 0, n: 0 };
    k.sum += union ? inter / union : 1;
    k.n++;
    st.chanByKind.set(item.kind, k);
  }
  const predT = new Set(pred.affectedTargets.map(tkey));
  const goldT = new Set((label.affectedTargets ?? []).map(tkey));
  st.tgtPred += predT.size;
  st.tgtGold += goldT.size;
  st.tgtTP += [...predT].filter((t) => goldT.has(t)).length;
  /* unsupported causality: asserting an economic channel where the label
   * says none exists, or ANY channel on a market_move (reaction ≠ cause) */
  st.causalN++;
  if (
    (item.kind === "market_move" && pred.channels.length > 0) ||
    (label.channels.length === 0 &&
      pred.channels.length > 0 &&
      lr <= RANK.indexOf("limited"))
  ) {
    st.causalBad++;
    st.misses.push(
      `CAUSAL ${item.kind}:${item.id.slice(0, 8)} pred=${pred.materiality}[${pred.channels}] label=${label.intrinsicMateriality} — ${item.title.slice(0, 55)}`,
    );
  }
}

function report(name: string, st: Stats) {
  if (!st.n) return;
  const pct = (a: number, b: number) => (b ? (a / b).toFixed(3) : "n/a");
  console.log(`\n══ ${name} — ${st.n} labeled ══`);
  console.log(
    `coverage  ${(1 - st.abstained / st.n).toFixed(3)}  (abstained ${st.abstained}/${st.n})`,
  );
  console.log(
    `accuracy  overall ${pct(st.exact, st.n)}  within-1 ${pct(st.within1, st.n)}  classified-only ${pct(st.classExact, st.classN)}`,
  );
  const matP = st.matTP / Math.max(1, st.matTP + st.matFP);
  const matR = st.matTP / Math.max(1, st.matTP + st.matFN);
  console.log(
    `'material' flag  P ${matP.toFixed(3)}  R ${matR.toFixed(3)}  F1 ${(matP + matR ? (2 * matP * matR) / (matP + matR) : 0).toFixed(3)}`,
  );
  console.log(
    `high-impact FP  ${st.hiFP}/${st.hiPred} = ${st.hiPred ? (st.hiFP / st.hiPred).toFixed(3) : "n/a"}`,
  );
  console.log(`channel IoU  ${pct(st.chanIoUSum, st.chanN)}`);
  for (const [k, v] of st.chanByKind)
    console.log(`    ${k.padEnd(18)} ${(v.sum / v.n).toFixed(3)}  (n=${v.n})`);
  const tP = st.tgtTP / Math.max(1, st.tgtPred);
  const tR = st.tgtTP / Math.max(1, st.tgtGold);
  console.log(
    `targets  P ${tP.toFixed(3)}  R ${tR.toFixed(3)}  F1 ${(tP + tR ? (2 * tP * tR) / (tP + tR) : 0).toFixed(3)}  (pred ${st.tgtPred} / gold ${st.tgtGold})`,
  );
  console.log(
    `unsupported-causality  ${st.causalBad}/${st.causalN} = ${(st.causalBad / st.causalN).toFixed(3)}`,
  );
  console.log("confusion (label → pred):");
  for (const [l, row] of st.confusion) {
    const cells = [...row.entries()].map(([p, c]) => `${p}:${c}`).join("  ");
    console.log(`    ${l.padEnd(10)} ${cells}`);
  }
  if (st.misses.length) {
    console.log(`  --- disagreements (${st.misses.length}) ---`);
    for (const m of st.misses.slice(0, 30)) console.log("   ", m);
  }
}

const corpus = JSON.parse(
  readFileSync("tests/fixtures/materiality-corpus.json", "utf8"),
);
const labelFile = JSON.parse(
  readFileSync("tests/fixtures/materiality-labels.json", "utf8"),
);
const labels: Record<string, LabelEntry> = labelFile.labels;

const holdout = blank();
const challenge = blank();
let reviewedN = 0;
let unreviewedHigh = 0;
for (const item of corpus.items as Item[]) {
  const label = labels[`${item.kind}:${item.id}`];
  if (!label) continue;
  if (label.reviewed === false && rank(label.intrinsicMateriality) >= MATERIAL)
    unreviewedHigh++;
  if (label.reviewed) reviewedN++;
  accumulate(item, label, item.sourceSet === "challenge" ? challenge : holdout);
}
/* optional separate challenge file */
try {
  const ch = JSON.parse(
    readFileSync("tests/fixtures/materiality-challenge.json", "utf8"),
  );
  const chLabels: Record<string, LabelEntry> = ch.labels ?? {};
  for (const item of ch.items as Item[])
    if (chLabels[`${item.kind}:${item.id}`])
      accumulate(item, chLabels[`${item.kind}:${item.id}`], challenge);
} catch {
  /* no challenge file yet */
}

report("HOLDOUT (live corpus)", holdout);
report("CHALLENGE (curated)", challenge);
console.log(
  `\nlabel provenance: ${reviewedN} reviewed · ${unreviewedHigh} unreviewed ≥meaningful`,
);
