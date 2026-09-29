/**
 * R7.1d.3b.2 — signature-poisoning benchmark over the replay corpus.
 *
 * Classifies every replayable resolver pair under the founding-immutable
 * entity anchor (Candidate D) and reports at BOTH grains:
 *   - decision grain (one resolver decision)
 *   - doc×event grain (the N attachment edges a winner decision carries)
 *
 * Effectiveness is joined to the reviewed attachment corpus/labels —
 * contamination_enabled is only "harmful poisoning capture" when it lands
 * on reviewed misclustered docs; on reviewed on-topic docs it is a
 * false-split risk for an immutable-anchor production policy.
 *
 *   node scripts/resolver/bench-signature-poisoning.mts [corpus.json]
 */
import {
  classifyReplay,
  type ReplayInput,
  type ReplayRecord,
} from "../../lib/resolver-counterfactual.ts";

const CORPUS = process.argv[2] ?? "tests/fixtures/resolver-replay-corpus.json";
const LABELS = "tests/fixtures/attachment-labels.json";
const ATTACH_CORPUS = "tests/fixtures/attachment-corpus.json";

const fs = await import("node:fs");
const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
const records: ReplayInput[] = corpus.records;

/* ------------------------- doc×event gold labels -------------------------- */
import { buildEdgeGold, type EdgeGold } from "./poisoning-gold.ts";
type Gold = EdgeGold;
const labels = JSON.parse(fs.readFileSync(LABELS, "utf8"));
const attachCorpusJson = JSON.parse(fs.readFileSync(ATTACH_CORPUS, "utf8"));
const edgeGold = buildEdgeGold(labels, attachCorpusJson);
const edgeDriverBacking = new Set(
  [...edgeGold].filter(([, g]) => g === "driver").map(([k]) => k),
);

/* ------------------------------ classify all ------------------------------ */
const results: ReplayRecord[] = records.map((r) =>
  classifyReplay(
    r,
    r.reconstructedCandidateEntities,
    r.reconstructedCandidateCoreEntities,
  ),
);

import { docEdgesOf, goldEffectiveness, pct } from "./poisoning-metrics.ts";
const cnt = (xs: unknown[], p: (x: never) => boolean) =>
  xs.filter(p as never).length;

/* ------------------------------ 8.1 coverage ------------------------------ */
const winners = results.filter((r) => r.winnerPair);
const nonWinners = results.filter((r) => !r.winnerPair);
const creates = winners.filter((r) => r.actualDecision === "create");
const merges = winners.filter((r) => r.actualDecision === "merge");
const indet = results.filter((r) => r.classification === "indeterminate");
const byReason = Object.fromEntries(
  [...new Set(indet.map((r) => r.indeterminateReason!))].map((reason) => [
    reason,
    indet.filter((r) => r.indeterminateReason === reason).length,
  ]),
);
const replayableMerges = merges.filter(
  (r) => r.classification !== "indeterminate",
);
const baselineChecked = merges.filter((r) => r.baselineReplayMatches !== null);
// events whose immutable founder anchor is derivable: a create with
// captured incoming sets (the event itself) or any pair whose candidate
// event resolved to a known anchor
const anchoredEvents = new Set<string>();
for (const r of results) {
  if (r.anchorEntities === null) continue;
  if (r.candidateEventId) anchoredEvents.add(r.candidateEventId);
  if (r.actualDecision === "create" && r.chosenEventId)
    anchoredEvents.add(r.chosenEventId);
}

/* --------------------------- 8.2 core classes ----------------------------- */
const klass = (k: string) => results.filter((r) => r.classification === k);
const pairs = results.filter((r) => r.actualDecision !== "create");
const replayable = pairs.filter((r) => r.classification !== "indeterminate");
const pathChanged = replayable.filter(
  (r) => r.samePath === false && r.classification === "same_decision",
);

/* ------------------------------ doc grain --------------------------------- */
const docEdges = docEdgesOf(results);
const gold = goldEffectiveness(docEdges, edgeGold);
const replayableEdges = docEdges.filter(
  (d) => d.rec.classification !== "indeterminate",
);

/* ------------------------------ 8.3 snowball ------------------------------ */
interface EventChain {
  eventId: string;
  merges: ReplayRecord[];
}
const chains: EventChain[] = [
  ...new Set(merges.map((r) => r.chosenEventId!)),
].map((eventId) => ({
  eventId,
  merges: merges
    .filter((r) => r.chosenEventId === eventId)
    .sort((a, b) => (a.decisionOrdinal ?? 0) - (b.decisionOrdinal ?? 0)),
}));
const snowball = chains.map((c) => {
  const firstFlipIdx = c.merges.findIndex(
    (m) => m.classification === "contamination_enabled",
  );
  const founder = new Set(c.merges[0]?.anchorEntities ?? []);
  const firstDiverge = c.merges.find(
    (m) => (m.nonFounderEntitiesBefore ?? []).length > 0,
  );
  return {
    eventId: c.eventId,
    merges: c.merges.length,
    firstDivergenceOrdinal: firstDiverge?.decisionOrdinal ?? null,
    firstFlipOrdinal:
      firstFlipIdx >= 0 ? c.merges[firstFlipIdx].decisionOrdinal : null,
    downstreamDecisionsAfterFlip:
      firstFlipIdx >= 0 ? c.merges.length - firstFlipIdx - 1 : 0,
    downstreamDocsAfterFlip:
      firstFlipIdx >= 0
        ? c.merges
            .slice(firstFlipIdx + 1)
            .reduce((n, m) => n + m.attachedEvidenceVersionIds.length, 0)
        : 0,
    nonFounderEntitiesBeforeFlip:
      firstFlipIdx >= 0
        ? (c.merges[firstFlipIdx].nonFounderEntitiesBefore ?? [])
        : [],
    // null = founder anchor not captured (pre-0044 event); 0 = verified
    // empty founding set — the NULL-vs-[] distinction carries through
    founderSize: c.merges[0]?.anchorEntities === null ? null : founder.size,
  };
});
const forensic = results
  .filter((r) => r.classification === "contamination_enabled")
  .map((r) => ({
    decisionId: r.resolverDecisionId.slice(0, 12),
    event: (r.chosenEventId ?? r.candidateEventId ?? "").slice(0, 12),
    ordinal: r.decisionOrdinal,
    actualPath: r.actualPath,
    stablePath: r.stablePath,
    anchor: r.anchorEntities,
    contextAdded: r.nonFounderEntitiesBefore,
    contextOnlyShared: r.contextOnlySharedEntities,
    docs: r.attachedEvidenceVersionIds.length,
  }));

/* ------------------------------ breakdowns -------------------------------- */
const breakdown = (key: (r: ReplayRecord) => string) => {
  const m = new Map<string, { total: number; enabled: number }>();
  for (const r of replayable) {
    const k = key(r);
    const e = m.get(k) ?? { total: 0, enabled: 0 };
    e.total++;
    if (r.classification === "contamination_enabled") e.enabled++;
    m.set(k, e);
  }
  return Object.fromEntries(m);
};

const out = {
  corpusHash: corpus.corpusHash,
  policy: corpus.policy,
  boundary: corpus.sourceBoundary,
  coverage: {
    decisions: results.length,
    creates: creates.length,
    winnerMerges: merges.length,
    nonWinners: nonWinners.length,
    replayable: replayable.length,
    replayableWinnerMerges: replayableMerges.length,
    indeterminate: indet.length,
    indeterminateByReason: byReason,
    baselineParityRate: pct(
      cnt(merges, (r: ReplayRecord) => r.baselineReplayMatches === true),
      baselineChecked.length,
    ),
    hashMismatches: cnt(
      results,
      (r: ReplayRecord) => r.indeterminateReason === "candidate_hash_mismatch",
    ),
    groupInvariantFailures: cnt(
      results,
      (r: ReplayRecord) =>
        r.indeterminateReason === "group_invariant_violation",
    ),
    founderKnownEvents: anchoredEvents.size,
    continuityGaps: cnt(
      merges,
      (r: ReplayRecord) => r.continuityMatch === false,
    ),
    originAttributionCompleteRate: pct(
      cnt(results, (r: ReplayRecord) => r.originAttributionComplete),
      results.length,
    ),
    emptyFounderAnchor: cnt(
      creates,
      (r: ReplayRecord) =>
        r.anchorEntities !== null && r.anchorEntities.length === 0,
    ),
    emptyMergeCandidate: cnt(
      merges,
      (r: ReplayRecord) =>
        r.actualCandidateEntitiesBefore !== null &&
        r.actualCandidateEntitiesBefore.length === 0,
    ),
  },
  classes: {
    decision: {
      same_decision: klass("same_decision").length,
      contamination_enabled: klass("contamination_enabled").length,
      contamination_blocked: klass("contamination_blocked").length,
      indeterminate: indet.length,
      rates_over_replayable: {
        same_decision: pct(klass("same_decision").length, replayable.length),
        contamination_enabled: pct(
          klass("contamination_enabled").length,
          replayable.length,
        ),
        contamination_blocked: pct(
          klass("contamination_blocked").length,
          replayable.length,
        ),
      },
      pathChangedSameOutcome: pathChanged.length,
    },
    docGrain: {
      attachedEdges: docEdges.length,
      replayableEdges: replayableEdges.length,
      reviewedReplayableEdges: gold.reviewedReplayable,
      under_contamination_enabled: replayableEdges.filter(
        (d) => d.rec.classification === "contamination_enabled",
      ).length,
    },
  },
  goldEffectiveness: gold,
  breakdowns: {
    byActualPath: breakdown((r) => r.actualPath),
    byStablePath: breakdown((r) => r.stablePath ?? "none"),
    byXlang: breakdown((r) => String(r.crossLanguage)),
    byTopic: breakdown((r) => r.topic ?? "unknown"),
    bySemanticAvailable: breakdown((r) => String(r.semanticAvailable)),
  },
  snowball: snowball.filter((s) => s.merges > 0),
  forensic,
};

console.log(JSON.stringify(out, null, 2));
