/* R7.1b — claim-level materiality benchmark.
 *
 *   npx tsx scripts/materiality/bench-claims.mts
 *
 * Runs the deterministic claim scorer (lib/materiality-claims.ts) over the
 * frozen claim corpus + claim challenge set and reports against
 * materiality-claims-labels.json. Per-family breakdowns are required —
 * an aggregate score alone hides failure modes (R7.0 lesson).
 */
import { readFileSync } from "node:fs";
import {
  scoreClaimMateriality,
  type ClaimMaterialityInput,
} from "../../lib/materiality-claims.ts";

const LEVELS = ["none", "limited", "meaningful", "major", "systemic"];
const MATERIAL = new Set(["meaningful", "major", "systemic"]);
const HIGH = new Set(["major", "systemic"]);

const corpus = JSON.parse(
  readFileSync("tests/fixtures/materiality-claims-corpus.json", "utf8"),
);
const challenge = JSON.parse(
  readFileSync("tests/fixtures/materiality-claims-challenge.json", "utf8"),
);
const labels = JSON.parse(
  readFileSync("tests/fixtures/materiality-claims-labels.json", "utf8"),
).labels as Record<
  string,
  {
    economicAction: string;
    intrinsicMateriality: string;
    scope: string | null;
    channels: string[];
    affectedTargets: string[];
    labeled_by: string;
    reviewed: boolean;
  }
>;

interface Scored {
  id: string;
  set: string;
  pred: ReturnType<typeof scoreClaimMateriality>;
  gold: (typeof labels)[string];
}
const scored: Scored[] = [];
for (const [setName, src] of [
  ["holdout", corpus.items ?? corpus],
  ["challenge", challenge.items],
] as const) {
  for (const item of src as (ClaimMaterialityInput & { eventId: string })[]) {
    const gold = labels[item.claimId];
    if (!gold) continue;
    scored.push({
      id: item.claimId,
      set: setName,
      pred: scoreClaimMateriality(item),
      gold,
    });
  }
}

const rank = (m: string) => LEVELS.indexOf(m);
const isMaterial = (m: string) => MATERIAL.has(m);
const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);

function setMetrics(rows: Scored[]) {
  const labeled = rows.length;
  const abstained = rows.filter((r) => r.pred.materiality === "unknown");
  const classified = rows.filter((r) => r.pred.materiality !== "unknown");
  const exact = classified.filter(
    (r) => r.pred.materiality === r.gold.intrinsicMateriality,
  ).length;
  const within1 = classified.filter(
    (r) =>
      Math.abs(rank(r.pred.materiality) - rank(r.gold.intrinsicMateriality)) <=
      1,
  ).length;

  // material flag P/R/F1
  const matTP = rows.filter(
    (r) =>
      isMaterial(r.pred.materiality) && isMaterial(r.gold.intrinsicMateriality),
  ).length;
  const matP = rows.filter((r) => isMaterial(r.pred.materiality));
  const matR = rows.filter((r) => isMaterial(r.gold.intrinsicMateriality));
  const prec = matP.length ? matTP / matP.length : 0;
  const rec = matR.length ? matTP / matR.length : 0;

  // high-impact false positives: pred major/systemic, gold < meaningful
  const hiFP = rows.filter(
    (r) =>
      HIGH.has(r.pred.materiality) &&
      !MATERIAL.has(r.gold.intrinsicMateriality),
  );
  // systemic recall
  const goldSys = rows.filter(
    (r) => r.gold.intrinsicMateriality === "systemic",
  );
  const sysHit = goldSys.filter(
    (r) => r.pred.materiality === "systemic",
  ).length;

  // channel IoU over labeled-with-channels rows
  let iouSum = 0,
    iouN = 0;
  for (const r of rows) {
    const goldChannels = r.gold.channels ?? [];
    if (!goldChannels.length) continue;
    const p = new Set(r.pred.channels);
    const g = new Set(goldChannels);
    const inter = [...p].filter((c) => g.has(c)).length;
    iouSum += inter / (p.size + g.size - inter || 1);
    iouN++;
  }

  // action accuracy + abstention
  const actHit = rows.filter(
    (r) => r.pred.action.type === r.gold.economicAction,
  ).length;
  const actAbstain = rows.filter(
    (r) => r.pred.action.type === "unknown_economic_action",
  ).length;

  // targets
  let tTP = 0,
    tP = 0,
    tG = 0;
  const tset = (t: { type: string; key: string }) => `${t.type}:${t.key}`;
  for (const r of rows) {
    const p = new Set(r.pred.affectedTargets.map(tset));
    const g = new Set(r.gold.affectedTargets ?? []);
    tTP += [...p].filter((t) => g.has(t)).length;
    tP += p.size;
    tG += g.size;
  }

  // unsupported causality: pred asserts channels gold didn't list
  const caus = rows.filter((r) => {
    const goldChannels = r.gold.channels ?? [];
    if (!goldChannels.length) return false;
    return r.pred.channels.some((c) => !goldChannels.includes(c));
  });

  // provenance
  const unrev = rows.filter(
    (r) => MATERIAL.has(r.gold.intrinsicMateriality) && !r.gold.reviewed,
  );

  return {
    labeled,
    abstained: abstained.length,
    coverage: labeled ? 1 - abstained.length / labeled : 0,
    accOverall: labeled ? exact / labeled : 0,
    accClassified: classified.length ? exact / classified.length : 0,
    within1: classified.length ? within1 / classified.length : 0,
    matP: prec,
    matR: rec,
    matF1: f1(prec, rec),
    hiFP: `${hiFP.length}/${classified.length || 1}`,
    hiFProws: hiFP.map((r) => r.id),
    sysRecall: goldSys.length ? `${sysHit}/${goldSys.length}` : "n/a",
    channelIoU: iouN ? iouSum / iouN : 0,
    actAcc: labeled ? actHit / labeled : 0,
    actAbstainRate: labeled ? actAbstain / labeled : 0,
    tP: tP ? tTP / tP : 0,
    tR: tG ? tTP / tG : 0,
    tF1: f1(tP ? tTP / tP : 0, tG ? tTP / tG : 0),
    causalityRate: labeled ? caus.length / labeled : 0,
    unreviewedMaterial: unrev.length,
  };
}

/* truth guardrails — challenge set holds the retracted/disputed cases */
function guardrails(rows: Scored[]) {
  const retractedOK = rows
    .filter((r) => r.pred.evidenceState === "retracted")
    .every((r) => r.pred.excluded && r.pred.materiality === "none");
  const disputed = rows.filter((r) => r.pred.evidenceState === "disputed");
  const disputedMagnitudePreserved = disputed.every((r) =>
    HIGH.has(r.gold.intrinsicMateriality)
      ? HIGH.has(r.pred.materiality) || r.pred.materiality === "meaningful"
      : true,
  );
  // only claims that actually transmit something can be capped — a
  // disputed claim scored none/unknown carries null confidence by design
  const disputedCapped = disputed
    .filter((r) => r.pred.transmissionConfidence !== null)
    .every((r) => r.pred.transmissionConfidence === "low");
  // rawSourceCount never feeds magnitude — two copies can't lift a claim
  return {
    retractedExcluded: retractedOK,
    disputedMagnitudePreserved,
    disputedTransmissionCapped: disputedCapped,
  };
}

function byFamily(rows: Scored[]) {
  const fams = new Map<string, Scored[]>();
  for (const r of rows) {
    const k = r.gold.economicAction;
    (fams.get(k) ?? fams.set(k, []).get(k)!).push(r);
  }
  const out: Record<string, object> = {};
  for (const [fam, rs] of [...fams.entries()].sort()) {
    out[fam] = {
      n: rs.length,
      actAcc:
        rs.filter((r) => r.pred.action.type === r.gold.economicAction).length /
        rs.length,
      acc:
        rs.filter((r) => r.pred.materiality === r.gold.intrinsicMateriality)
          .length / rs.length,
    };
  }
  return out;
}

const holdout = scored.filter((s) => s.set === "holdout");
const chal = scored.filter((s) => s.set === "challenge");

const print = (name: string, m: ReturnType<typeof setMetrics>) =>
  console.log(
    `\n${name} (${m.labeled} labeled)\n` +
      `  coverage           ${m.coverage.toFixed(3)}  (abstained ${m.abstained})\n` +
      `  accuracy           overall ${m.accOverall.toFixed(3)} · classified-only ${m.accClassified.toFixed(3)} · within-1 ${m.within1.toFixed(3)}\n` +
      `  material flag      P ${m.matP.toFixed(3)} · R ${m.matR.toFixed(3)} · F1 ${m.matF1.toFixed(3)}\n` +
      `  high-impact FP     ${m.hiFP}${m.hiFProws.length ? " → " + m.hiFProws.join(", ") : ""}\n` +
      `  systemic recall    ${m.sysRecall}\n` +
      `  action             acc ${m.actAcc.toFixed(3)} · abstention ${m.actAbstainRate.toFixed(3)}\n` +
      `  channel IoU        ${m.channelIoU.toFixed(3)}\n` +
      `  targets            P ${m.tP.toFixed(3)} · R ${m.tR.toFixed(3)} · F1 ${m.tF1.toFixed(3)}\n` +
      `  unsupported causal ${m.causalityRate.toFixed(3)}\n` +
      `  unreviewed ≥mean.  ${m.unreviewedMaterial}`,
  );

print("HOLDOUT", setMetrics(holdout));
print("CHALLENGE", setMetrics(chal));
console.log(
  "\nPER-FAMILY (holdout):",
  JSON.stringify(byFamily(holdout), null, 1),
);
console.log("PER-FAMILY (challenge):", JSON.stringify(byFamily(chal), null, 1));
console.log("\nGUARDRAILS:", JSON.stringify(guardrails(scored), null, 1));
