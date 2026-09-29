/**
 * R7.1d.3b.2 — stable-anchor counterfactual replay.
 *
 * Answers, for every replayable historical resolver pair: if the candidate
 * event had exposed only its IMMUTABLE founding entity identity (the
 * create_new_event provenance row's incoming entity sets) to the
 * entity-dependent gates, while every non-entity signal stayed frozen,
 * would the pair decision have been the same?
 *
 * The evaluator is the production one: decideWithFeatures() with entity
 * features recomputed from substituted entity sets and every other
 * PairFeatures field frozen. Thresholds come from the decision's own
 * snapshot, never today's constants. This is measurement, not policy —
 * nothing here changes production merge behavior.
 */
import {
  decideWithFeatures,
  HUB_ENTITIES,
  jaccard,
  repHash,
  type DecideSideCtx,
  type PairFeatures,
  type ResolverDecision,
  type ResolverThresholds,
} from "./resolver";

/* ------------------------------- types ----------------------------------- */

export interface ReplayInput {
  resolverDecisionId: string;
  incomingCluster: string | null;
  candidateEventId: string | null;
  chosenEventId: string | null;
  /** this decision is the winner that attached a cluster's docs */
  winnerPair: boolean;
  decisionAt: string;
  /** rank among the candidate event's winning merge decisions */
  decisionOrdinal: number | null;
  actualDecision: string; // create | merge | split | ambiguous
  actualPath: string;
  actualScore: number | null;
  /** frozen PairFeatures — provenance explanation (winners) or
   *  resolver_decisions.features (non-winners); {} = volume-stripped */
  features: Partial<PairFeatures> | null;
  thresholds: ResolverThresholds | null;
  incomingEntities: string[] | null;
  incomingCoreEntities: string[] | null;
  /** winner merges only: candidate's pre-merge entity signature */
  candidateEntitiesBefore: string[] | null;
  candidateCoreEntitiesBefore: string[] | null;
  candidateSignatureHashBefore: string | null;
  /** non-winner baseline: candidate entity sets reconstructed by replaying
   *  the candidate event's own merge history up to this decision */
  reconstructedCandidateEntities: string[] | null;
  reconstructedCandidateCoreEntities: string[] | null;
  /** candidate event's immutable founder anchor — null when its founding
   *  provenance predates entity-set capture (0044) or provenance itself */
  anchorEntities: string[] | null;
  anchorCoreEntities: string[] | null;
  /** candidate (target) event topic — breakdown dimension */
  topic: string | null;
  crossLanguage: boolean | null;
  semanticAvailable: boolean;
  attachedEvidenceVersionIds: string[];
  /** §3.2: provenance edges in this decision disagree — never
   *  majority-voted, always indeterminate */
  groupInvariantViolation?: boolean;
  /** non-winner whose incoming_cluster has no winner provenance to
   *  recover incoming entity sets from */
  incomingClusterNotLinkable?: boolean;
}

export type ReplayClassification =
  | "create"
  | "same_decision"
  | "contamination_enabled"
  | "contamination_blocked"
  | "indeterminate";

export const INDETERMINATE_REASONS = [
  "missing_founder_anchor",
  "missing_incoming_entities",
  "missing_candidate_entities",
  "missing_threshold_snapshot",
  "candidate_hash_mismatch",
  "anchor_not_subset_of_candidate",
  "group_invariant_violation",
  "baseline_replay_mismatch",
  "features_filtered",
  "generic_incident_scope_not_snapshotted",
  "incoming_cluster_not_linkable",
  "candidate_event_history_missing",
  "policy_context_missing",
] as const;
export type IndeterminateReason = (typeof INDETERMINATE_REASONS)[number];

export interface ReplayRecord {
  resolverDecisionId: string;
  incomingCluster: string | null;
  candidateEventId: string | null;
  chosenEventId: string | null;
  winnerPair: boolean;
  decisionAt: string;
  decisionOrdinal: number | null;

  actualDecision: string;
  actualPath: string;
  actualScore: number | null;
  stableDecision: string | null;
  stablePath: string | null;
  stableScore: number | null;

  classification: ReplayClassification;
  indeterminateReason: IndeterminateReason | null;

  anchorEntities: string[] | null;
  anchorCoreEntities: string[] | null;
  actualCandidateEntitiesBefore: string[] | null;
  actualCandidateCoreEntitiesBefore: string[] | null;
  incomingEntities: string[] | null;
  incomingCoreEntities: string[] | null;

  /** candidate entities at decision time that are not founder identity */
  nonFounderEntitiesBefore: string[] | null;
  /** shared entities that exist only because of accumulated context */
  contextOnlySharedEntities: string[] | null;
  contextOnlySharedCoreEntities: string[] | null;

  baselineReplayMatches: boolean | null;
  samePath: boolean | null;
  continuityMatch: boolean | null;
  originAttributionComplete: boolean;

  topic: string | null;
  crossLanguage: boolean | null;
  semanticAvailable: boolean;
  attachedEvidenceVersionIds: string[];
}

/* ------------------------- entity-set evaluation -------------------------- */

/**
 * Recompute only the entity-dependent PairFeatures fields against a
 * substituted candidate entity signature. Everything else stays frozen —
 * the counterfactual must isolate entity-signature poisoning and nothing
 * else.
 */
export function withCandidateEntities(
  frozen: PairFeatures,
  incomingEntities: string[],
  incomingCoreEntities: string[],
  candidateEntities: string[],
  candidateCoreEntitiesRaw: string[],
): PairFeatures {
  const incFull = new Set(incomingEntities);
  const incCore = new Set(incomingCoreEntities);
  const candFull = new Set(candidateEntities);
  // production: candidate.entitySignatureCore || candidate.entitySignature
  const effCore =
    candidateCoreEntitiesRaw.length > 0
      ? candidateCoreEntitiesRaw
      : candidateEntities;
  const candCore = new Set(effCore);
  const sharedCore = incomingCoreEntities.filter((e) => candCore.has(e));
  return {
    ...frozen,
    entitySimilarity: jaccard(incFull, candFull),
    coreEntitySimilarity: jaccard(incCore, candCore),
    sharedEntities: incomingEntities.filter((e) => candFull.has(e)),
    sharedCoreEntities: sharedCore,
    nonHubSharedCore: sharedCore.filter((e) => !HUB_ENTITIES.has(e)),
  };
}

function sideCtx(
  f: PairFeatures,
  incomingEntities: string[],
  incomingCoreEntities: string[],
  candidateEntities: string[],
  effectiveCore: string[],
  incGenericAllIncident: boolean,
): DecideSideCtx {
  return {
    incCoreCount: incomingCoreEntities.length,
    incCoreList: incomingCoreEntities.join(","),
    candCoreCount: effectiveCore.length,
    candCoreSig: effectiveCore.join(" "),
    incEntCount: incomingEntities.length,
    candEntCount: candidateEntities.length,
    // overlap denominators make these exact where the gate needs them:
    // overlap > 0 ⟺ count > 0; overlap == 0 fails the gate either way
    incDistinctiveCount: f.distinctiveClaimOverlap > 0 ? 1 : 0,
    incGenericCount: f.genericClaimOverlap > 0 ? 1 : 0,
    incGenericAllIncident,
    // the time gate is entity-independent — the historical decision
    // already carries its verdict; replays inherit it frozen
    topicWindowHours: null,
    candPublishedAt: undefined,
  };
}

/**
 * Run decideWithFeatures against substituted candidate sets. The
 * generic_claim zero-entity fallback depends on incGenericAllIncident,
 * which history does not snapshot — evaluate incident=false first and let
 * the caller re-evaluate with true to detect whether the fallback is
 * decisive (spec §5 generic_incident_scope_not_snapshotted).
 */
export function evalCandidate(
  frozen: PairFeatures,
  thresholds: ResolverThresholds,
  incomingEntities: string[],
  incomingCoreEntities: string[],
  candidateEntities: string[],
  candidateCoreEntitiesRaw: string[],
  incGenericAllIncident: boolean,
): ResolverDecision {
  const f = withCandidateEntities(
    frozen,
    incomingEntities,
    incomingCoreEntities,
    candidateEntities,
    candidateCoreEntitiesRaw,
  );
  const effCore =
    candidateCoreEntitiesRaw.length > 0
      ? candidateCoreEntitiesRaw
      : candidateEntities;
  return decideWithFeatures(
    f,
    sideCtx(
      f,
      incomingEntities,
      incomingCoreEntities,
      candidateEntities,
      effCore,
      incGenericAllIncident,
    ),
    thresholds,
  );
}

/* ----------------------------- classification ----------------------------- */

const isEmptyObj = (o: object | null) => !o || Object.keys(o).length === 0;
const sorted = (a: string[]) => [...a].sort();
const eq = (a: string[] | null, b: string[] | null) =>
  a !== null && b !== null && sorted(a).join(" ") === sorted(b).join(" ");
const subset = (small: string[], big: string[]) => {
  const s = new Set(big);
  return small.every((e) => s.has(e));
};

function indeterminate(
  r: ReplayInput,
  reason: IndeterminateReason,
  extra: Partial<ReplayRecord> = {},
): ReplayRecord {
  return {
    resolverDecisionId: r.resolverDecisionId,
    incomingCluster: r.incomingCluster,
    candidateEventId: r.candidateEventId,
    chosenEventId: r.chosenEventId,
    winnerPair: r.winnerPair,
    decisionAt: r.decisionAt,
    decisionOrdinal: r.decisionOrdinal,
    actualDecision: r.actualDecision,
    actualPath: r.actualPath,
    actualScore: r.actualScore,
    stableDecision: null,
    stablePath: null,
    stableScore: null,
    classification: "indeterminate",
    indeterminateReason: reason,
    anchorEntities: r.anchorEntities,
    anchorCoreEntities: r.anchorCoreEntities,
    actualCandidateEntitiesBefore: r.candidateEntitiesBefore,
    actualCandidateCoreEntitiesBefore: r.candidateCoreEntitiesBefore,
    incomingEntities: r.incomingEntities,
    incomingCoreEntities: r.incomingCoreEntities,
    nonFounderEntitiesBefore: null,
    contextOnlySharedEntities: null,
    contextOnlySharedCoreEntities: null,
    baselineReplayMatches: null,
    samePath: null,
    continuityMatch: null,
    originAttributionComplete: true,
    topic: r.topic,
    crossLanguage: r.crossLanguage,
    semanticAvailable: r.semanticAvailable,
    attachedEvidenceVersionIds: r.attachedEvidenceVersionIds,
    ...extra,
  };
}

/**
 * Classify one resolver-decision pair under the founding-immutable-anchor
 * counterfactual. `observedContext` is the reconstructed candidate entity
 * state for continuity diagnostics (anchor ∪ incoming of prior merges).
 */
export function classifyReplay(
  r: ReplayInput,
  observedContextEntities: string[] | null = null,
  observedContextCoreEntities: string[] | null = null,
): ReplayRecord {
  if (r.actualDecision === "create") {
    return {
      ...indeterminate(r, "missing_founder_anchor"),
      classification: "create",
      indeterminateReason: null,
    };
  }

  // frozen hard block — entity substitution provably cannot lift it
  if (r.actualPath === "time_window") {
    const base = indeterminate(r, "features_filtered");
    return {
      ...base,
      stableDecision: "split",
      stablePath: "time_window",
      stableScore: 0,
      classification: "same_decision",
      indeterminateReason: null,
      samePath: true,
      baselineReplayMatches: null,
    };
  }

  if (r.groupInvariantViolation)
    return indeterminate(r, "group_invariant_violation");

  const f = r.features;
  if (isEmptyObj(f)) return indeterminate(r, "features_filtered");
  // incoming recovery precedes the threshold check: an unlinkable
  // incoming_cluster loses BOTH the entity sets and the inherited
  // threshold snapshot — report the root cause, not the symptom
  if (r.incomingEntities === null || r.incomingCoreEntities === null)
    return indeterminate(
      r,
      r.incomingClusterNotLinkable
        ? "incoming_cluster_not_linkable"
        : "missing_incoming_entities",
    );
  if (!r.thresholds) return indeterminate(r, "missing_threshold_snapshot");
  if (!r.candidateEventId)
    return indeterminate(r, "candidate_event_history_missing");

  const winnerMerge = r.winnerPair && r.actualDecision === "merge";

  // candidate entity sets actually evaluated historically
  const actualCand = winnerMerge
    ? r.candidateEntitiesBefore
    : r.reconstructedCandidateEntities;
  const actualCandCore = winnerMerge
    ? r.candidateCoreEntitiesBefore
    : r.reconstructedCandidateCoreEntities;

  if (winnerMerge) {
    // NULL/empty semantics (spec §4.1): merge candidates must be arrays
    if (
      r.candidateEntitiesBefore === null ||
      r.candidateCoreEntitiesBefore === null
    )
      return indeterminate(r, "missing_candidate_entities");
    // hash check — stored signature hash must match the captured sets
    const expect = repHash(sorted(r.candidateEntitiesBefore).join(" "));
    if (r.candidateSignatureHashBefore !== expect)
      return indeterminate(r, "candidate_hash_mismatch");
  } else if (actualCand === null || actualCandCore === null) {
    return indeterminate(r, "candidate_event_history_missing");
  }

  if (r.anchorEntities === null || r.anchorCoreEntities === null)
    return indeterminate(r, "missing_founder_anchor");

  // accumulate-only model: founder identity must be inside the candidate
  // signature the pair was actually evaluated against
  const effCandCore =
    actualCandCore!.length > 0 ? actualCandCore! : actualCand!;
  if (
    !subset(r.anchorEntities, actualCand!) ||
    !subset(r.anchorCoreEntities, effCandCore)
  )
    return indeterminate(r, "anchor_not_subset_of_candidate");

  const continuityMatch = winnerMerge
    ? eq(observedContextEntities, r.candidateEntitiesBefore) &&
      eq(observedContextCoreEntities, r.candidateCoreEntitiesBefore)
    : null;

  // — baseline parity: replay with the recorded actual candidate sets
  //   must reproduce the recorded outcome+path, else the replay context
  //   is missing a hidden input (never silently score it)
  const frozen = f as PairFeatures;
  const evalWith = (candEnt: string[], candCore: string[], incident: boolean) =>
    evalCandidate(
      frozen,
      r.thresholds!,
      r.incomingEntities!,
      r.incomingCoreEntities!,
      candEnt,
      candCore,
      incident,
    );

  const baseNo = evalWith(actualCand!, actualCandCore!, false);
  let baseline = baseNo;
  let incidentProven = false;
  const baseYes = evalWith(actualCand!, actualCandCore!, true);
  const incidentDecisive =
    baseNo.decision !== baseYes.decision || baseNo.path !== baseYes.path;
  if (incidentDecisive) {
    // the zero-entity generic_claim fallback changed the answer — only
    // legitimate when history itself proves it fired (generic_claim path
    // recorded) — otherwise the incident-scope input is not replayable
    if (
      baseYes.decision === r.actualDecision &&
      baseYes.path === r.actualPath
    ) {
      baseline = baseYes;
      incidentProven = true;
    }
  }
  if (baseline.decision !== r.actualDecision || baseline.path !== r.actualPath)
    return indeterminate(r, "baseline_replay_mismatch", {
      continuityMatch,
      baselineReplayMatches: false,
    });

  // — stable-anchor run: same frozen features, candidate entities replaced
  const stableNo = evalWith(r.anchorEntities, r.anchorCoreEntities, false);
  const stableYes = evalWith(r.anchorEntities, r.anchorCoreEntities, true);
  const stableIncidentDecisive =
    stableNo.decision !== stableYes.decision ||
    stableNo.path !== stableYes.path;
  let stable = stableNo;
  if (stableIncidentDecisive) {
    if (!incidentProven)
      return indeterminate(r, "generic_incident_scope_not_snapshotted", {
        continuityMatch,
        baselineReplayMatches: true,
      });
    stable = stableYes;
  }

  const nonFounder = actualCand!.filter((e) => !r.anchorEntities!.includes(e));
  const effAnchorCore =
    r.anchorCoreEntities.length > 0 ? r.anchorCoreEntities : r.anchorEntities;
  const actualShared = r.incomingEntities!.filter((e) =>
    actualCand!.includes(e),
  );
  const stableShared = r.incomingEntities!.filter((e) =>
    r.anchorEntities!.includes(e),
  );
  const actualSharedCore = r.incomingCoreEntities!.filter((e) =>
    effCandCore.includes(e),
  );
  const stableSharedCore = r.incomingCoreEntities!.filter((e) =>
    effAnchorCore.includes(e),
  );

  // ambiguous persists as split — a non-merge → non-merge transition does
  // not change any event boundary, so it counts as same_decision
  // (samePath=false records the path drift). contamination_* requires a
  // real merge↔non-merge flip.
  const classification: ReplayClassification =
    stable.decision === r.actualDecision
      ? "same_decision"
      : r.actualDecision === "merge"
        ? "contamination_enabled"
        : stable.decision === "merge"
          ? "contamination_blocked"
          : "same_decision";

  return {
    resolverDecisionId: r.resolverDecisionId,
    incomingCluster: r.incomingCluster,
    candidateEventId: r.candidateEventId,
    chosenEventId: r.chosenEventId,
    winnerPair: r.winnerPair,
    decisionAt: r.decisionAt,
    decisionOrdinal: r.decisionOrdinal,
    actualDecision: r.actualDecision,
    actualPath: r.actualPath,
    actualScore: r.actualScore,
    stableDecision: stable.decision,
    stablePath: stable.path,
    stableScore: stable.score,
    classification,
    indeterminateReason: null,
    anchorEntities: r.anchorEntities,
    anchorCoreEntities: r.anchorCoreEntities,
    actualCandidateEntitiesBefore: actualCand,
    actualCandidateCoreEntitiesBefore: actualCandCore,
    incomingEntities: r.incomingEntities,
    incomingCoreEntities: r.incomingCoreEntities,
    nonFounderEntitiesBefore: nonFounder,
    contextOnlySharedEntities: actualShared.filter(
      (e) => !stableShared.includes(e),
    ),
    contextOnlySharedCoreEntities: actualSharedCore.filter(
      (e) => !stableSharedCore.includes(e),
    ),
    baselineReplayMatches: true,
    samePath: stable.path === r.actualPath,
    continuityMatch,
    originAttributionComplete: continuityMatch !== false,
    topic: r.topic,
    crossLanguage: r.crossLanguage,
    semanticAvailable: r.semanticAvailable,
    attachedEvidenceVersionIds: r.attachedEvidenceVersionIds,
  };
}
