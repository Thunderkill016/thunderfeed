/* R7.1d.3a.1 — reproducible attachment-corpus metrics. Every number the
 * audit cites comes from THIS script over the frozen pair:
 *   tests/fixtures/attachment-corpus.json  (standing-evidence snapshot)
 *   tests/fixtures/attachment-labels.json  (reviewed labels + proxies)
 * No impact figure is hand-computed.
 *
 * Metrics:
 *   - label distribution + cause-proxy/confidence distribution
 *   - level inflation: max(all-claim materiality) > max(on-story claims)
 *   - high-level foreign-only: event reaches ≥meaningful ONLY via
 *     misclustered claims
 *   - doc fanout of misclustered-claim docs (active event attachments):
 *     median / P90 / max
 *   - extraction gaps (invariant-checked: on-story doc + 0 on-story
 *     claims) and fully-foreign contamination events
 */
import { readFileSync } from "node:fs";

const corpus = JSON.parse(
  readFileSync("tests/fixtures/attachment-corpus.json", "utf8"),
);
const labels = JSON.parse(
  readFileSync("tests/fixtures/attachment-labels.json", "utf8"),
);
if (labels.corpusHash !== corpus.corpusHash) {
  console.error(
    `label/corpus hash mismatch: ${labels.corpusHash} vs ${corpus.corpusHash} — re-dump or re-label`,
  );
  process.exit(1);
}

const RANK = ["none", "limited", "meaningful", "major", "systemic"];
const rank = (m: string | null | undefined) =>
  m && RANK.includes(m) ? RANK.indexOf(m) : -1; // unknown/unscored = below none

const corpusEvents = new Map<string, any>(
  corpus.events.map((e: any) => [e.eventId, e]),
);

let claimsTotal = 0;
const labelDist: Record<string, number> = {};
const causeDist: Record<string, number> = {};
const confDist: Record<string, number> = {};
const fanouts = new Map<string, number>(); // docId → active event count
let inflated = 0;
let highForeignOnly = 0;
const inflatedIds: string[] = [];
const highForeignOnlyIds: string[] = [];

for (const ev of labels.events) {
  const ce = corpusEvents.get(ev.eventId);
  if (!ce) throw new Error(`labels reference missing event ${ev.eventId}`);

  let allMax = -1;
  let cleanMax = -1;
  for (const cl of ce.claims) {
    claimsTotal++;
    const lab = ev.claims[cl.claimId];
    if (!lab) throw new Error(`unlabeled claim ${cl.claimId}`);
    labelDist[lab] = (labelDist[lab] ?? 0) + 1;
    const r = rank(cl.materiality);
    allMax = Math.max(allMax, r);
    if (lab !== "misclustered") cleanMax = Math.max(cleanMax, r);
    else {
      const proxy = ev.causeProxies[cl.claimId];
      const conf = ev.causeConfidence[cl.claimId];
      if (!proxy)
        throw new Error(`misclustered claim ${cl.claimId} has no causeProxy`);
      causeDist[proxy] = (causeDist[proxy] ?? 0) + 1;
      confDist[conf] = (confDist[conf] ?? 0) + 1;
      for (const d of cl.standingEvidence)
        fanouts.set(d.documentId, d.activeEvents.length);
    }
  }
  if (allMax > cleanMax) {
    inflated++;
    inflatedIds.push(ev.eventId);
  }
  if (allMax >= rank("meaningful") && cleanMax < rank("meaningful")) {
    highForeignOnly++;
    highForeignOnlyIds.push(ev.eventId);
  }

  // gap invariant — re-verified against corpus, not trusted from labels
  if (ev.extractionGap) {
    if (!ev.onStoryEventEvidence.length)
      throw new Error(`gap event ${ev.eventId} has no on-story doc`);
    if (
      cleanMax >= 0 ||
      Object.values(ev.claims).some((v) => v !== "misclustered")
    )
      throw new Error(`gap event ${ev.eventId} has a surviving on-story claim`);
  }
}

const sorted = [...fanouts.values()].sort((a, b) => a - b);
const pct = (p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
    : 0;

console.log(
  JSON.stringify(
    {
      corpusHash: corpus.corpusHash,
      events: labels.events.length,
      claims: claimsTotal,
      labelDist,
      causeProxyDist: causeDist,
      causeConfidenceDist: confDist,
      inflatedEvents: inflated,
      highLevelForeignOnly: highForeignOnly,
      misclusteredDocFanout: {
        docs: fanouts.size,
        median: pct(0.5),
        p90: pct(0.9),
        max: sorted.at(-1) ?? 0,
      },
      extractionGaps: labels.extractionGapEvents.length,
      fullyForeignEvents: labels.fullyForeignEvents.length,
    },
    null,
    2,
  ),
);
console.log("\ninflated:", inflatedIds.map((s) => s.slice(0, 13)).join(" "));
console.log(
  "highForeignOnly:",
  highForeignOnlyIds.map((s) => s.slice(0, 13)).join(" "),
);
