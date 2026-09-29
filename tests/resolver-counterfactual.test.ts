/* R7.1d.3b.2 — stable-anchor counterfactual replay.
 * Covers the issue #2 test list: anchor semantics, NULL-vs-[], hash/parity
 * integrity gates, all four classifications, incident-scope indeterminacy,
 * group invariants, frozen thresholds, gold-effectiveness guardrails and
 * corpus-hash determinism. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReplay,
  withCandidateEntities,
  type ReplayInput,
} from "../lib/resolver-counterfactual";
import {
  decide,
  repHash,
  RESOLVER_THRESHOLDS,
  type PairFeatures,
  type ResolverThresholds,
} from "../lib/resolver";
import {
  deriveAnchors,
  groupProvenanceEdges,
  replayCorpusHash,
  type ProvenanceEdgeLike,
} from "../scripts/resolver/replay-corpus";
import { buildEdgeGold } from "../scripts/resolver/poisoning-gold";
import {
  docEdgesOf,
  goldEffectiveness,
} from "../scripts/resolver/poisoning-metrics";

/* -------------------------------- helpers --------------------------------- */

const NONHUB_A = "acme_corp";
const NONHUB_B = "globex_inc";
const NONHUB_C = "initech_llc";
const PERSON = "putin";
const HUB = "vietnam";

const mkFeatures = (over: Partial<PairFeatures> = {}): PairFeatures => ({
  lexicalSimilarity: 0.25, // below headline/rare bars, ≥ entity floor
  semanticSimilarity: undefined,
  coreEntitySimilarity: 0,
  entitySimilarity: 0,
  sharedCoreEntities: [],
  sharedEntities: [],
  nonHubSharedCore: [],
  distinctiveClaimOverlap: 0,
  genericClaimOverlap: 0,
  sharedRareTokens: [],
  sharedBigrams: [],
  numberAgreement: false,
  numberConflict: false,
  timeDeltaHours: 1,
  sameLanguage: true,
  ...over,
});

let seq = 0;
const mkInput = (over: Partial<ReplayInput> = {}): ReplayInput => ({
  resolverDecisionId: `d${++seq}`,
  incomingCluster: `c${seq}`,
  candidateEventId: "E1",
  chosenEventId: "E1",
  winnerPair: true,
  decisionAt: "2026-01-01T00:00:00Z",
  decisionOrdinal: 1,
  actualDecision: "merge",
  actualPath: "entity",
  actualScore: 0.7,
  features: mkFeatures(),
  thresholds: RESOLVER_THRESHOLDS,
  incomingEntities: [NONHUB_A],
  incomingCoreEntities: [NONHUB_A],
  candidateEntitiesBefore: [NONHUB_A],
  candidateCoreEntitiesBefore: [NONHUB_A],
  candidateSignatureHashBefore: repHash(NONHUB_A),
  reconstructedCandidateEntities: [NONHUB_A],
  reconstructedCandidateCoreEntities: [NONHUB_A],
  anchorEntities: [NONHUB_A],
  anchorCoreEntities: [NONHUB_A],
  topic: "world",
  crossLanguage: false,
  semanticAvailable: false,
  attachedEvidenceVersionIds: ["ev1"],
  ...over,
});

const mkEdge = (
  over: Partial<ProvenanceEdgeLike> = {},
): ProvenanceEdgeLike => ({
  resolver_decision_id: "dec1",
  event_id: "E1",
  evidence_version_id: "ev1",
  decision: "merge",
  path: "entity",
  incoming_cluster: "c1",
  candidate_event_id: "E1",
  score: 0.7,
  candidate_signature_hash_before: repHash(NONHUB_A),
  candidate_entities_before: [NONHUB_A],
  candidate_core_entities_before: [NONHUB_A],
  incoming_entities: [NONHUB_A],
  incoming_core_entities: [NONHUB_A],
  cross_language: false,
  explanation: { lexicalSimilarity: 0.25, thresholds: RESOLVER_THRESHOLDS },
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

/* ------------------------- 1-3: decision-grain grouping -------------------- */

test("1. create seeds the immutable anchor once", () => {
  const edges = [
    mkEdge({
      decision: "create",
      path: "create_new_event",
      evidence_version_id: "ev1",
      incoming_entities: [NONHUB_A],
      incoming_core_entities: [NONHUB_A],
    }),
    mkEdge({
      decision: "create",
      path: "create_new_event",
      evidence_version_id: "ev2",
      incoming_entities: [NONHUB_A],
      incoming_core_entities: [NONHUB_A],
    }),
  ];
  const { winners } = groupProvenanceEdges(edges);
  const anchors = deriveAnchors(winners);
  assert.equal(winners.length, 1);
  assert.deepEqual(anchors.get("E1"), {
    entities: [NONHUB_A],
    core: [NONHUB_A],
  });
});

test("2. N-doc create decision dedupes to one replay step", () => {
  const edges = ["ev1", "ev2", "ev3"].map((ev) =>
    mkEdge({
      decision: "create",
      path: "create_new_event",
      evidence_version_id: ev,
      candidate_event_id: null,
      candidate_entities_before: null,
      candidate_core_entities_before: null,
      candidate_signature_hash_before: null,
    }),
  );
  const { winners, groupInvariantFailures } = groupProvenanceEdges(edges);
  assert.equal(winners.length, 1);
  assert.equal(groupInvariantFailures, 0);
  assert.deepEqual(winners[0].evidenceVersionIds, ["ev1", "ev2", "ev3"]);
});

test("3. N-doc merge decision dedupes to one replay step", () => {
  const edges = ["ev9", "ev7"].map((ev) => mkEdge({ evidence_version_id: ev }));
  const { winners } = groupProvenanceEdges(edges);
  assert.equal(winners.length, 1);
  assert.deepEqual(winners[0].evidenceVersionIds, ["ev7", "ev9"]);
});

/* --------------------------- 4-6: NULL vs [] ------------------------------- */

test("4. create with NULL candidate sets is valid (no candidate existed)", () => {
  const r = classifyReplay(
    mkInput({
      actualDecision: "create",
      actualPath: "create_new_event",
      candidateEventId: null,
      candidateEntitiesBefore: null,
      candidateCoreEntitiesBefore: null,
      candidateSignatureHashBefore: null,
      anchorEntities: null,
      anchorCoreEntities: null,
    }),
  );
  assert.equal(r.classification, "create");
  assert.equal(r.indeterminateReason, null);
});

test("5. merge candidate=[] is valid and replayable (ec7628a regression)", () => {
  // a verified-empty candidate signature must NOT read as "not captured"
  const r = classifyReplay(
    mkInput({
      actualPath: "headline",
      features: mkFeatures({ lexicalSimilarity: 0.9 }),
      incomingEntities: [],
      incomingCoreEntities: [],
      candidateEntitiesBefore: [],
      candidateCoreEntitiesBefore: [],
      candidateSignatureHashBefore: repHash(""),
      anchorEntities: [],
      anchorCoreEntities: [],
    }),
  );
  assert.equal(r.classification, "same_decision");
  assert.equal(r.stablePath, "headline");
});

test("6. pre-0044 founder with NULL incoming sets → missing_founder_anchor", () => {
  const r = classifyReplay(
    mkInput({ anchorEntities: null, anchorCoreEntities: null }),
  );
  assert.equal(r.classification, "indeterminate");
  assert.equal(r.indeterminateReason, "missing_founder_anchor");
});

/* --------------------------- 7-9: integrity gates -------------------------- */

test("7. core-empty candidate falls back to full anchor like production", () => {
  // anchor core empty → effective core = full anchor (production:
  // entitySignatureCore || entitySignature). Without the fallback the
  // entity path could not fire and this would wrongly flip.
  const r = classifyReplay(
    mkInput({
      candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
      candidateCoreEntitiesBefore: [], // stored core empty → effective=full
      candidateSignatureHashBefore: repHash(
        [NONHUB_A, NONHUB_B].sort().join(" "),
      ),
      anchorEntities: [NONHUB_A, NONHUB_B],
      anchorCoreEntities: [],
      incomingEntities: [NONHUB_A],
      incomingCoreEntities: [NONHUB_A],
      actualPath: "entity",
    }),
  );
  assert.equal(r.classification, "same_decision");
  assert.equal(r.stablePath, "entity");
  assert.equal(r.baselineReplayMatches, true);
});

test("8. anchor not ⊆ candidate signature → anchor_not_subset_of_candidate", () => {
  const r = classifyReplay(
    mkInput({
      anchorEntities: [NONHUB_A, "stray_anchor"],
      anchorCoreEntities: [NONHUB_A, "stray_anchor"],
      candidateEntitiesBefore: [NONHUB_A],
      candidateCoreEntitiesBefore: [NONHUB_A],
      candidateSignatureHashBefore: repHash(NONHUB_A),
    }),
  );
  assert.equal(r.indeterminateReason, "anchor_not_subset_of_candidate");
});

test("9. candidate signature hash mismatch → candidate_hash_mismatch", () => {
  const r = classifyReplay(
    mkInput({ candidateSignatureHashBefore: repHash("tampered") }),
  );
  assert.equal(r.indeterminateReason, "candidate_hash_mismatch");
});

/* ------------------------- 10-12: baseline parity -------------------------- */

test("10. baseline actual-set replay reproduces headline path", () => {
  const r = classifyReplay(
    mkInput({
      actualPath: "headline",
      features: mkFeatures({ lexicalSimilarity: 0.8 }),
      incomingEntities: [],
      incomingCoreEntities: [],
      candidateEntitiesBefore: [NONHUB_A],
      candidateCoreEntitiesBefore: [NONHUB_A],
      anchorEntities: [NONHUB_A],
      anchorCoreEntities: [NONHUB_A],
    }),
  );
  assert.equal(r.baselineReplayMatches, true);
  assert.equal(r.actualPath, "headline");
});

test("11. baseline actual-set replay reproduces generic_claim path", () => {
  // diluted candidate core (jaccard 1/3) keeps the entity path from
  // firing first — generic_claim is reached via entitySimilarity > 0,
  // never the incident-scope fallback
  const r = classifyReplay(
    mkInput({
      actualPath: "generic_claim",
      features: mkFeatures({ genericClaimOverlap: 0.8 }),
      incomingEntities: [NONHUB_A],
      incomingCoreEntities: [NONHUB_A],
      candidateEntitiesBefore: [NONHUB_A, NONHUB_B, NONHUB_C],
      candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B, NONHUB_C],
      candidateSignatureHashBefore: repHash(
        [NONHUB_A, NONHUB_B, NONHUB_C].sort().join(" "),
      ),
      anchorEntities: [NONHUB_A],
      anchorCoreEntities: [NONHUB_A],
    }),
  );
  assert.equal(r.baselineReplayMatches, true);
  assert.equal(r.classification, "same_decision");
});

test("12. baseline replay reproduces semantic_xlang + semantic_anchored", () => {
  const xlang = classifyReplay(
    mkInput({
      actualPath: "semantic_xlang",
      features: mkFeatures({
        lexicalSimilarity: 0.05,
        semanticSimilarity: 0.8,
        sameLanguage: false,
      }),
    }),
  );
  assert.equal(xlang.baselineReplayMatches, true);
  assert.equal(xlang.stablePath, "semantic_xlang");

  const anchored = classifyReplay(
    mkInput({
      actualPath: "semantic_anchored",
      features: mkFeatures({
        lexicalSimilarity: 0.05,
        semanticSimilarity: 0.75, // below xlang band, inside anchored band
      }),
    }),
  );
  assert.equal(anchored.baselineReplayMatches, true);
  assert.equal(anchored.stablePath, "semantic_anchored");
});

/* ----------------------- 13-16: the four classes --------------------------- */

test("13. entity introduced by an earlier merge enables the merge → contamination_enabled", () => {
  // founder={A}; merge #1 accumulated B into the signature; this pair's
  // incoming={B} shares ONLY the accumulated entity. Under the stable
  // anchor {A} the pair is entity-blocked → the accumulated context was
  // NECESSARY for this merge.
  const r = classifyReplay(
    mkInput({
      candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
      candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B],
      candidateSignatureHashBefore: repHash(
        [NONHUB_A, NONHUB_B].sort().join(" "),
      ),
      reconstructedCandidateEntities: [NONHUB_A, NONHUB_B],
      reconstructedCandidateCoreEntities: [NONHUB_A, NONHUB_B],
      incomingEntities: [NONHUB_B],
      incomingCoreEntities: [NONHUB_B],
      anchorEntities: [NONHUB_A],
      anchorCoreEntities: [NONHUB_A],
      actualPath: "entity",
    }),
  );
  assert.equal(r.classification, "contamination_enabled");
  assert.equal(r.actualDecision, "merge");
  assert.equal(r.stableDecision, "split");
  assert.deepEqual(r.contextOnlySharedEntities, [NONHUB_B]);
  assert.deepEqual(r.nonFounderEntitiesBefore, [NONHUB_B]);
});

test("14. founder identity still shared → same_decision", () => {
  const r = classifyReplay(
    mkInput({
      candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
      candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B],
      candidateSignatureHashBefore: repHash(
        [NONHUB_A, NONHUB_B].sort().join(" "),
      ),
      incomingEntities: [NONHUB_A],
      incomingCoreEntities: [NONHUB_A],
      anchorEntities: [NONHUB_A],
      anchorCoreEntities: [NONHUB_A],
    }),
  );
  assert.equal(r.classification, "same_decision");
  assert.equal(r.samePath, true);
});

test("15. accumulated context dilutes similarity below the bar → contamination_blocked", () => {
  // non-winner split: coreSim 1/4=0.25 fails the entity path; under the
  // founder anchor {A} the same pair is coreSim 1.0 → merge
  const r = classifyReplay(
    mkInput({
      winnerPair: false,
      actualDecision: "split",
      actualPath: "no_path",
      candidateEntitiesBefore: null,
      candidateCoreEntitiesBefore: null,
      candidateSignatureHashBefore: null,
      reconstructedCandidateEntities: [
        NONHUB_A,
        NONHUB_B,
        NONHUB_C,
        "initech_global",
      ],
      reconstructedCandidateCoreEntities: [
        NONHUB_A,
        NONHUB_B,
        NONHUB_C,
        "initech_global",
      ],
      anchorEntities: [NONHUB_A],
      anchorCoreEntities: [NONHUB_A],
      incomingEntities: [NONHUB_A],
      incomingCoreEntities: [NONHUB_A],
      attachedEvidenceVersionIds: [],
    }),
  );
  assert.equal(r.classification, "contamination_blocked");
  assert.equal(r.stableDecision, "merge");
});

test("16. stable outcome merges via a different path → same_decision, samePath=false", () => {
  // actual: shared person {putin} + sig 0.25 → person path
  // stable anchor {C}: putin gone; bigram_entity fires instead
  const r = classifyReplay(
    mkInput({
      actualPath: "person",
      features: mkFeatures({ sharedBigrams: ["summit_hold"] }),
      incomingEntities: [NONHUB_C, PERSON],
      incomingCoreEntities: [NONHUB_C, PERSON],
      candidateEntitiesBefore: [NONHUB_C, PERSON],
      candidateCoreEntitiesBefore: [NONHUB_C, PERSON],
      candidateSignatureHashBefore: repHash(
        [NONHUB_C, PERSON].sort().join(" "),
      ),
      anchorEntities: [NONHUB_C],
      anchorCoreEntities: [NONHUB_C],
    }),
  );
  assert.equal(r.classification, "same_decision");
  assert.equal(r.actualPath, "person");
  assert.equal(r.stablePath, "bigram_entity");
  assert.equal(r.samePath, false);
});

/* --------------------- 17-19: indeterminate guards ------------------------- */

test("17. unprovable generic incident-scope fallback → indeterminate, never guessed", () => {
  // non-winner split: incoming no entities, anchor empty → stable replay
  // makes the zero-entity generic_claim fallback decisive, but history
  // never consulted INCIDENT_SCOPED → cannot be proven
  const r = classifyReplay(
    mkInput({
      winnerPair: false,
      actualDecision: "split",
      actualPath: "no_path",
      features: mkFeatures({
        lexicalSimilarity: 0.1,
        genericClaimOverlap: 0.6,
      }),
      incomingEntities: [],
      incomingCoreEntities: [],
      candidateEntitiesBefore: null,
      candidateCoreEntitiesBefore: null,
      candidateSignatureHashBefore: null,
      reconstructedCandidateEntities: ["initech_global"],
      reconstructedCandidateCoreEntities: ["initech_global"],
      anchorEntities: [],
      anchorCoreEntities: [],
      attachedEvidenceVersionIds: [],
    }),
  );
  assert.equal(r.indeterminateReason, "generic_incident_scope_not_snapshotted");
});

test("18. volume-stripped split features → indeterminate features_filtered", () => {
  const r = classifyReplay(mkInput({ winnerPair: false, features: {} }));
  assert.equal(r.indeterminateReason, "features_filtered");
});

test("19. disagreeing provenance edges → group_invariant_violation", () => {
  const { winners, groupInvariantFailures } = groupProvenanceEdges([
    mkEdge({ evidence_version_id: "ev1", path: "entity" }),
    mkEdge({ evidence_version_id: "ev2", path: "headline" }), // disagree
  ]);
  assert.equal(groupInvariantFailures, 1);
  const r = classifyReplay(mkInput({ groupInvariantViolation: true }));
  assert.equal(r.indeterminateReason, "group_invariant_violation");
});

/* --------------------- 20-22: determinism + drift -------------------------- */

test("20. equal timestamps order deterministically by decision id", () => {
  const a = mkInput({ resolverDecisionId: "zzz", decisionAt: "T" });
  const b = mkInput({ resolverDecisionId: "aaa", decisionAt: "T" });
  const sorted = [a, b].sort((x, y) =>
    x.decisionAt === y.decisionAt
      ? x.resolverDecisionId.localeCompare(y.resolverDecisionId)
      : x.decisionAt < y.decisionAt
        ? -1
        : 1,
  );
  assert.equal(sorted[0].resolverDecisionId, "aaa");
});

test("21. frozen threshold snapshot is used, not today's constant", () => {
  // snapshot has a LOOSER rare-token floor than the current constant —
  // replay must honour the snapshot (0.15 ≥ 0.1) where today's 0.2 fails
  const snapshot: ResolverThresholds = {
    ...RESOLVER_THRESHOLDS,
    rareSigFloor: 0.1,
  };
  const r = classifyReplay(
    mkInput({
      actualPath: "rare_token",
      features: mkFeatures({
        lexicalSimilarity: 0.15,
        sharedRareTokens: ["halongstorm"],
      }),
      incomingEntities: [],
      incomingCoreEntities: [],
      candidateEntitiesBefore: [],
      candidateCoreEntitiesBefore: [],
      candidateSignatureHashBefore: repHash(""),
      anchorEntities: [],
      anchorCoreEntities: [],
      thresholds: snapshot,
    }),
  );
  assert.equal(r.baselineReplayMatches, true);
  assert.equal(r.actualPath, "rare_token");
});

test("22. policy drift that cannot reproduce the pair → baseline_replay_mismatch", () => {
  // history recorded a rare_token merge but the snapshot floor (0.9)
  // rejects sig 0.25 — the replay context cannot reproduce it
  const r = classifyReplay(
    mkInput({
      actualPath: "rare_token",
      features: mkFeatures({
        lexicalSimilarity: 0.25,
        sharedRareTokens: ["halongstorm"],
      }),
      thresholds: { ...RESOLVER_THRESHOLDS, rareSigFloor: 0.9 },
      incomingEntities: [],
      incomingCoreEntities: [],
      candidateEntitiesBefore: [],
      candidateCoreEntitiesBefore: [],
      candidateSignatureHashBefore: repHash(""),
      anchorEntities: [],
      anchorCoreEntities: [],
    }),
  );
  assert.equal(r.indeterminateReason, "baseline_replay_mismatch");
  assert.equal(r.baselineReplayMatches, false);
});

/* ------------------ 23-26: gold-effectiveness guardrails ------------------- */

const mkRec = (over: Partial<ReplayInput> = {}) =>
  classifyReplay(mkInput(over));

test("23. reviewed on-topic contamination_enabled edge → false-split numerator", () => {
  const rec = mkRec({
    chosenEventId: "E1",
    candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateSignatureHashBefore: repHash(
      [NONHUB_A, NONHUB_B].sort().join(" "),
    ),
    incomingEntities: [NONHUB_B],
    incomingCoreEntities: [NONHUB_B],
    attachedEvidenceVersionIds: ["evX"],
  });
  assert.equal(rec.classification, "contamination_enabled");
  const edgeGold = new Map([["E1|evX", "on_topic" as const]]);
  const eff = goldEffectiveness(docEdgesOf([rec]), edgeGold);
  assert.equal(eff.false_split_doc_rate.num, 1);
  assert.equal(eff.false_split_doc_rate.den, 1);
  assert.equal(eff.miscluster_block_recall.num, 0);
});

test("24. reviewed misclustered contamination_enabled edge → block-recall numerator", () => {
  const rec = mkRec({
    chosenEventId: "E1",
    candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateSignatureHashBefore: repHash(
      [NONHUB_A, NONHUB_B].sort().join(" "),
    ),
    incomingEntities: [NONHUB_B],
    incomingCoreEntities: [NONHUB_B],
    attachedEvidenceVersionIds: ["evY"],
  });
  const edgeGold = new Map([["E1|evY", "misclustered" as const]]);
  const eff = goldEffectiveness(docEdgesOf([rec]), edgeGold);
  assert.equal(eff.miscluster_block_recall.num, 1);
  assert.equal(eff.block_precision.num, 1);
  assert.equal(eff.false_split_doc_rate.num, 0);
});

test("25. mixed-doc decision contributes to both block-recall and false-split", () => {
  const rec = mkRec({
    chosenEventId: "E1",
    candidateEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateCoreEntitiesBefore: [NONHUB_A, NONHUB_B],
    candidateSignatureHashBefore: repHash(
      [NONHUB_A, NONHUB_B].sort().join(" "),
    ),
    incomingEntities: [NONHUB_B],
    incomingCoreEntities: [NONHUB_B],
    attachedEvidenceVersionIds: ["evOntopic", "evForeign"],
  });
  const edgeGold = new Map([
    ["E1|evOntopic", "on_topic" as const],
    ["E1|evForeign", "misclustered" as const],
  ]);
  const eff = goldEffectiveness(docEdgesOf([rec]), edgeGold);
  assert.equal(eff.miscluster_block_recall.num, 1);
  assert.equal(eff.false_split_doc_rate.num, 1);
  assert.equal(eff.block_precision.den, 2);
});

test("26. indeterminate edges stay out of denominators but show in coverage", () => {
  const ind = classifyReplay(
    mkInput({
      winnerPair: false,
      features: {},
      attachedEvidenceVersionIds: [],
    }),
  );
  assert.equal(ind.classification, "indeterminate");
  const edges = docEdgesOf([ind]);
  const eff = goldEffectiveness(edges, new Map());
  assert.equal(eff.reviewedEdges, 0);
  assert.equal(eff.indeterminateEdges, edges.length);
  // never silently counted as safe — no denominator receives it
  assert.equal(eff.miscluster_block_recall.den, 0);
});

/* ------------------------- 27: corpus hash ---------------------------------- */

test("27. corpus hash is shuffle-stable and generatedAt-independent", () => {
  const recs = [mkInput(), mkInput(), mkInput()] as unknown as Record<
    string,
    unknown
  >[];
  const h1 = replayCorpusHash(recs);
  const h2 = replayCorpusHash([...recs].reverse());
  assert.equal(h1, h2);
  // entity-set order must not perturb the hash
  const reordered = recs.map((r) => ({
    ...(r as unknown as ReplayInput),
    incomingEntities: [
      ...((r as unknown as ReplayInput).incomingEntities ?? []),
    ].reverse(),
  }));
  assert.equal(replayCorpusHash(reordered as never), h1);
  // a semantic change DOES change the hash
  const mutated = recs.map((r, i) =>
    i === 0 ? { ...r, actualPath: "headline" } : r,
  );
  assert.notEqual(replayCorpusHash(mutated as never), h1);
});

/* ----------------------- production parity sanity --------------------------- */

test("decide() and decideWithFeatures() share one evaluator", () => {
  // the refactored decide() routes through the same gate logic the
  // counterfactual uses — sanity-checked end to end on a real pair
  const inc = {
    signature: "world|a b c|20|a_b",
    sigTokens: new Set(["a", "b", "c"]),
    numTokens: new Set<string>(),
    bigTokens: new Set<string>(),
    entTokens: new Set([NONHUB_A]),
    entCoreTokens: new Set([NONHUB_A]),
    distinctiveKeys: new Set<string>(),
    genericFps: new Set<string>(),
    topic: "world",
    language: "en",
    publishedAt: Date.parse("2026-01-01"),
  };
  const cand = {
    id: "E1",
    signature: "world|a b d||a_b",
    entitySignature: NONHUB_A,
    entitySignatureCore: NONHUB_A,
    claimKeys: new Set<string>(),
    claimFps: new Set<string>(),
    language: "en",
    publishedAt: Date.parse("2026-01-01T01:00:00Z"),
  };
  const d = decide(inc, cand);
  assert.equal(d.decision, "merge"); // entity corroborated
  assert.equal(d.path, "entity");
});

test("withCandidateEntities replaces only entity fields", () => {
  const frozen = mkFeatures({
    lexicalSimilarity: 0.42,
    semanticSimilarity: 0.9,
    sharedRareTokens: ["tok"],
    numberAgreement: true,
  });
  const f = withCandidateEntities(
    frozen,
    [NONHUB_A, NONHUB_B],
    [NONHUB_A],
    [NONHUB_A, NONHUB_C],
    [],
  );
  // recomputed
  assert.deepEqual(f.sharedEntities.sort(), [NONHUB_A]);
  assert.deepEqual(f.sharedCoreEntities, [NONHUB_A]); // empty core → full fallback
  assert.equal(f.entitySimilarity, 1 / 3); // jaccard {A,B} vs {A,C}
  // frozen
  assert.equal(f.lexicalSimilarity, 0.42);
  assert.equal(f.semanticSimilarity, 0.9);
  assert.deepEqual(f.sharedRareTokens, ["tok"]);
  assert.equal(f.numberAgreement, true);
});
