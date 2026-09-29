/* R7.1d.1 event-materiality benchmark.
 *
 * Two corpora, one aggregation path:
 *   1. tests/fixtures/materiality-events-synthetic.json — 25 invariant cases
 *      (must be 100%; failure = aggregator semantics bug, not noise)
 *   2. tests/fixtures/materiality-events-corpus.json  — frozen canonical-prod
 *      claim_materiality_current joined to events (270 events)
 *      × materiality-events-labels.json — ~80 reviewed labels
 *
 * Metrics vs labels: exact + within-one accuracy, per-level P/R/F1,
 * high-materiality false positives (+annotated cause), channel IoU,
 * typed-target P/R, driver P/R, scope accuracy/over-under-broad,
 * weak-evidence over-elevation, coverage audit. Legacy R7.0 baseline
 * (scoreEventMateriality predicate bag) runs on the same events for a
 * direct before/after comparison.
 *
 *   npx tsx scripts/materiality/bench-events.mts
 */
import { readFileSync } from "node:fs";

import {
  aggregateClaimsToEvent,
  type ClaimMaterialityAssessment,
} from "../../lib/materiality-claims.ts";
import {
  scoreEventMateriality,
  type EventEntity,
} from "../../lib/materiality.ts";

const LEVELS = ["none", "limited", "meaningful", "major", "systemic"];
const rank = (m: string) => (m === "unknown" ? -1 : LEVELS.indexOf(m));
const HIGH = new Set(["meaningful", "major", "systemic"]);
/* issuer < sector < vietnam < global_systemic — same lattice the
 * aggregator uses; over/under-broad measured against it */
const SCOPE_RANK: Record<string, number> = {
  issuer: 0,
  sector: 1,
  vietnam: 2,
  global_systemic: 3,
};

/* deterministic shuffle — same seed everywhere so the run is byte-stable */
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── synthetic gate ─────────────────────────────────────────── */
const synth = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-synthetic.json", "utf8"),
);
let synthFail = 0;
const synthLines: string[] = [];
for (const c of synth.cases) {
  const out = aggregateClaimsToEvent(c.claims as ClaimMaterialityAssessment[]);
  const errs: string[] = [];
  const e = c.expect;
  if (e.materiality && out.materiality !== e.materiality)
    errs.push(`materiality=${out.materiality} want=${e.materiality}`);
  if (e.scope !== undefined && out.scope !== e.scope)
    errs.push(`scope=${out.scope} want=${e.scope}`);
  if (e.channels)
    if (JSON.stringify(out.channels) !== JSON.stringify(e.channels))
      errs.push(`channels=${JSON.stringify(out.channels)}`);
  if (e.targets)
    if (JSON.stringify(out.affectedTargets) !== JSON.stringify(e.targets))
      errs.push(`targets=${JSON.stringify(out.affectedTargets)}`);
  if (e.cautions)
    if (JSON.stringify(out.cautions) !== JSON.stringify(e.cautions))
      errs.push(`cautions=${JSON.stringify(out.cautions)}`);
  if (e.confidence && out.confidence !== e.confidence)
    errs.push(`confidence=${out.confidence} want=${e.confidence}`);
  if (e.allDriversLevel) {
    const matById = new Map<string, string>(
      (c.claims as ClaimMaterialityAssessment[]).map((x) => [
        x.claimId,
        x.materiality,
      ]),
    );
    for (const id of out.driverClaimIds)
      if (matById.get(id) !== e.allDriversLevel)
        errs.push(`driver ${id} level=${matById.get(id)}`);
  }
  if (e.driversEqContributors)
    if (
      JSON.stringify(out.driverClaimIds) !==
      JSON.stringify(out.contributingClaimIds)
    )
      errs.push("drivers != contributors on sub-meaningful event");
  if (e.noDriverLevels) {
    const matById = new Map<string, string>(
      (c.claims as ClaimMaterialityAssessment[]).map((x) => [
        x.claimId,
        x.materiality,
      ]),
    );
    for (const id of out.driverClaimIds)
      if (e.noDriverLevels.includes(matById.get(id)))
        errs.push(`non-material claim ${id} in drivers`);
  }
  /* shuffle invariance — every case, not just the labeled one */
  const sh = aggregateClaimsToEvent(
    shuffle(c.claims as ClaimMaterialityAssessment[], 42),
  );
  if (JSON.stringify(sh) !== JSON.stringify(out))
    errs.push("NOT shuffle-invariant");
  if (errs.length) {
    synthFail++;
    synthLines.push(`  FAIL ${c.id}: ${errs.join("; ")}`);
  }
}
console.log(
  `synthetic: ${synth.cases.length - synthFail}/${synth.cases.length} pass`,
);
for (const l of synthLines) console.log(l);
if (synthFail) process.exit(1);

/* ── labeled real corpus ────────────────────────────────────── */
const corpus = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-corpus.json", "utf8"),
);
interface EventLabel {
  eventId: string;
  title: string;
  materiality: string;
  /** reviewed scope — null is a reviewed conclusion, not "unlabeled" */
  scope: string | null;
  scopeReviewed: boolean;
  channels: string[];
  /** typed targets as "type:key" strings */
  affectedTargets: string[];
  driverClaimIds: string[];
  /** high-FP cause: upstream_miscluster | claim_scorer | aggregation | label_abstention | other */
  fpCause: string | null;
  reviewed: boolean;
  note: string;
}
const labels = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-labels.json", "utf8"),
) as { corpusHash: string; labels: EventLabel[] };
if (labels.corpusHash !== corpus.corpusHash) {
  console.error(
    `label/corpus hash mismatch: ${labels.corpusHash} vs ${corpus.corpusHash} — re-dump`,
  );
  process.exit(1);
}
const goldById = new Map(labels.labels.map((l) => [l.eventId, l]));

const confusion: Record<string, Record<string, number>> = {};
let exact = 0,
  within1 = 0,
  hiFP = 0,
  hiFN = 0,
  compared = 0;
let chIouSum = 0,
  chN = 0,
  drvTP = 0,
  drvP = 0,
  drvR = 0,
  drvN = 0;
let tgTP = 0,
  tgP = 0,
  tgR = 0,
  tgN = 0;
let weakEvidenceElev = 0;
let scopeN = 0,
  scopeExact = 0,
  scopeOver = 0,
  scopeUnder = 0;
const fpCauses: Record<string, number> = {};
const covSum = { total: 0, unknown: 0, excluded: 0, material: 0 };
const legacy = { exact: 0, within1: 0, hiFP: 0, n: 0 };
const divergences: string[] = [];

for (const it of corpus.items) {
  const gold = goldById.get(it.eventId);
  const claims = (
    it.claims as { assessment: ClaimMaterialityAssessment }[]
  ).map((c) => c.assessment);
  const out = aggregateClaimsToEvent(claims);
  covSum.total += out.coverage.totalClaims;
  covSum.unknown += out.coverage.unknownClaims;
  covSum.excluded += out.coverage.excludedClaims;
  covSum.material += out.coverage.materialClaims;
  if (!gold) continue;
  compared++;

  const g = gold.materiality,
    p = out.materiality;
  (confusion[g] ??= {})[p] = ((confusion[g] ??= {})[p] ?? 0) + 1;
  if (p === g) exact++;
  if (rank(p) !== -1 && rank(g) !== -1 && Math.abs(rank(p) - rank(g)) <= 1)
    within1++;
  if (HIGH.has(p) && !HIGH.has(g)) {
    hiFP++;
    fpCauses[gold.fpCause ?? "unannotated"] =
      (fpCauses[gold.fpCause ?? "unannotated"] ?? 0) + 1;
  }
  if (!HIGH.has(p) && HIGH.has(g)) hiFN++;
  /* weak-evidence over-elevation: event lands ≥2 levels above gold AND
   * every driver rests on reported/disputed/unresolved truth states.
   * (Named precisely: a perfectly-evidenced claim mis-clustered onto the
   * wrong event is upstream contamination, captured by fpCause instead.) */
  if (rank(p) - rank(g) >= 2) {
    const drv = new Set(out.driverClaimIds);
    const allWeak = claims
      .filter((c) => drv.has(c.claimId))
      .every((c) =>
        ["reported", "disputed", "unresolved"].includes(c.evidenceState),
      );
    if (allWeak) weakEvidenceElev++;
  }
  /* scope accuracy on reviewed labels only — null scope is a reviewed
   * "no economic scope" conclusion, compared as-is */
  if (gold.scopeReviewed) {
    scopeN++;
    const gs = gold.scope,
      ps = out.scope;
    if (gs === ps) scopeExact++;
    else if (gs !== null && ps !== null) {
      if (SCOPE_RANK[ps] > SCOPE_RANK[gs]) scopeOver++;
      else scopeUnder++;
    } else if (gs === null && ps !== null) scopeOver++;
    else scopeUnder++;
  }
  if (gold.channels && gold.channels.length + out.channels.length > 0) {
    const gs = new Set<string>(gold.channels),
      ps = new Set<string>(out.channels);
    const inter = [...gs].filter((x) => ps.has(x)).length;
    chIouSum += inter / (gs.size + ps.size - inter || 1);
    chN++;
  }
  if (
    gold.driverClaimIds &&
    (gold.driverClaimIds.length || out.driverClaimIds.length)
  ) {
    const gs = new Set(gold.driverClaimIds),
      ps = new Set(out.driverClaimIds);
    drvTP += [...gs].filter((x) => ps.has(x)).length;
    drvP += ps.size;
    drvR += gs.size;
    drvN++;
  }
  if (
    gold.affectedTargets &&
    (gold.affectedTargets.length || out.affectedTargets.length)
  ) {
    const gk = new Set(gold.affectedTargets),
      pk = new Set(out.affectedTargets.map((t) => `${t.type}:${t.key}`));
    tgTP += [...gk].filter((x) => pk.has(x)).length;
    tgP += pk.size;
    tgR += gk.size;
    tgN++;
  }
  /* legacy R7.0 baseline on the same event */
  const l = scoreEventMateriality({
    predicates: it.predicates,
    entities: it.entities as EventEntity[],
    topic: it.topic,
  });
  legacy.n++;
  if (l.materiality === g) legacy.exact++;
  if (
    rank(l.materiality) !== -1 &&
    rank(g) !== -1 &&
    Math.abs(rank(l.materiality) - rank(g)) <= 1
  )
    legacy.within1++;
  if (HIGH.has(l.materiality) && !HIGH.has(g)) legacy.hiFP++;
  if (p !== g)
    divergences.push(
      `${it.eventId.slice(0, 8)} gold=${g} new=${p} legacy=${l.materiality} | ${it.title.slice(0, 70)}`,
    );
}

console.log(
  `\nlabeled events: ${compared}/${corpus.items.length} corpus events`,
);
console.log(
  `exact           ${exact}/${compared} = ${(exact / compared).toFixed(3)}`,
);
console.log(
  `within-1        ${within1}/${compared} = ${(within1 / compared).toFixed(3)}`,
);
console.log(`hi-material FP  ${hiFP}   (pred ≥meaningful, gold <meaningful)`);
console.log(`hi-material FN  ${hiFN}   (gold ≥meaningful, pred <meaningful)`);
console.log(
  `weak-evidence-elev ${weakEvidenceElev}  (≥2-level over gold, weak evidence only)`,
);
console.log(
  `channel IoU     ${chN ? (chIouSum / chN).toFixed(3) : "-"} over ${chN}`,
);
console.log(
  `driver P/R      ${drvR ? (drvTP / drvP).toFixed(3) : "-"}/${drvR ? (drvTP / drvR).toFixed(3) : "-"} over ${drvN}`,
);
console.log(
  `target P/R      ${tgR ? (tgTP / tgP).toFixed(3) : "-"}/${tgR ? (tgTP / tgR).toFixed(3) : "-"} over ${tgN}`,
);
console.log(
  `scope           exact=${scopeN ? (scopeExact / scopeN).toFixed(3) : "-"} over-broad=${scopeOver} under-broad=${scopeUnder} on ${scopeN} reviewed`,
);
console.log(
  `hi-FP causes    ${
    Object.entries(fpCauses)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ") || "-"
  }`,
);
console.log(
  `coverage totals claims=${covSum.total} unknown=${covSum.unknown} excluded=${covSum.excluded} material=${covSum.material}`,
);
console.log(
  `\nlegacy R7.0     exact=${legacy.exact}/${legacy.n} (${(legacy.exact / legacy.n).toFixed(3)}) within-1=${legacy.within1} hiFP=${legacy.hiFP}`,
);
console.log("\nconfusion (gold → pred):");
for (const g of [...LEVELS, "unknown"])
  if (confusion[g]) console.log(`  ${g.padEnd(10)}`, confusion[g]);
console.log(`\ndivergences (${divergences.length}):`);
for (const d of divergences) console.log(`  ${d}`);
