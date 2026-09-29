/**
 * R7.1d.3b.2 — poisoning-bench metric computation, shared between the
 * bench script (live corpus) and the regression tests (synthetic edges).
 */
import type { ReplayRecord } from "../../lib/resolver-counterfactual.ts";
import type { EdgeGold } from "./poisoning-gold.ts";

export interface DocEdge {
  eventId: string;
  evId: string;
  rec: ReplayRecord;
}

export const pct = (a: number, b: number) =>
  b === 0 ? null : +((a / b) * 100).toFixed(1);

/** doc×event edges carried by winner decisions — the doc grain */
export function docEdgesOf(records: ReplayRecord[]): DocEdge[] {
  return records
    .filter((r) => r.winnerPair)
    .flatMap((r) =>
      r.attachedEvidenceVersionIds.map((ev) => ({
        eventId: r.chosenEventId ?? r.candidateEventId!,
        evId: ev,
        rec: r,
      })),
    );
}

/**
 * §9 effectiveness: mechanical contamination_enabled classes are joined
 * to reviewed gold. Denominators are replayable-only AND published with
 * their indeterminate counts — never divide by the convenient subset.
 */
export function goldEffectiveness(
  edges: DocEdge[],
  edgeGold: Map<string, EdgeGold>,
) {
  const goldOf = (d: DocEdge) =>
    edgeGold.get(`${d.eventId}|${d.evId}`) ?? "unreviewed";
  const replayable = edges.filter(
    (d) => d.rec.classification !== "indeterminate",
  );
  const reviewed = edges.filter((d) => edgeGold.has(`${d.eventId}|${d.evId}`));
  const reviewedReplayable = reviewed.filter(
    (d) => d.rec.classification !== "indeterminate",
  );
  const enabled = reviewedReplayable.filter(
    (d) => d.rec.classification === "contamination_enabled",
  );
  const misc = reviewedReplayable.filter((d) => goldOf(d) === "misclustered");
  const ontopic = reviewedReplayable.filter((d) => goldOf(d) === "on_topic");
  const driverBacking = reviewedReplayable.filter(
    (d) => goldOf(d) === "driver",
  );
  return {
    reviewedEdges: reviewed.length,
    reviewedReplayable: reviewedReplayable.length,
    unreviewedEdges: edges.length - reviewed.length,
    indeterminateEdges: edges.length - replayable.length,
    miscluster_block_recall: {
      num: enabled.filter((d) => goldOf(d) === "misclustered").length,
      den: misc.length,
      rate: pct(
        enabled.filter((d) => goldOf(d) === "misclustered").length,
        misc.length,
      ),
    },
    block_precision: {
      num: enabled.filter((d) => goldOf(d) === "misclustered").length,
      den: enabled.length,
      rate: pct(
        enabled.filter((d) => goldOf(d) === "misclustered").length,
        enabled.length,
      ),
    },
    false_split_doc_rate: {
      num: enabled.filter((d) => goldOf(d) === "on_topic").length,
      den: ontopic.length,
      rate: pct(
        enabled.filter((d) => goldOf(d) === "on_topic").length,
        ontopic.length,
      ),
    },
    driver_evidence_loss: {
      num: enabled.filter((d) => goldOf(d) === "driver").length,
      den: driverBacking.length,
      rate: pct(
        enabled.filter((d) => goldOf(d) === "driver").length,
        driverBacking.length,
      ),
    },
  };
}

/* ---------------- R7.1d.3b.2a — coverage maturation ---------------- */

/**
 * Era is read off data completeness, not wall-clock guesses: a provenance
 * row written under 0044+ always carries incoming entity sets ([] counts,
 * NULL does not). NULL incoming entities = legacy pre-0044 row; for a
 * non-winner it can also mean its cluster has no linkable winner — either
 * way the record cannot be attributed to the post-0044 telemetry regime.
 */
export type CoverageEra = "post_0044" | "legacy_or_unlinked";
export const eraOf = (r: { incomingEntities: string[] | null }): CoverageEra =>
  r.incomingEntities === null ? "legacy_or_unlinked" : "post_0044";

/** coverage split — post-0044 winner attachments are expected ~100% replayable */
export function coverageByEra(records: ReplayRecord[]) {
  const per = (list: ReplayRecord[]) => {
    const winners = list.filter((r) => r.winnerPair);
    const merges = winners.filter((r) => r.actualDecision === "merge");
    const reasons: Record<string, number> = {};
    for (const r of list)
      if (r.indeterminateReason)
        reasons[r.indeterminateReason] =
          (reasons[r.indeterminateReason] ?? 0) + 1;
    return {
      decisions: list.length,
      winners: winners.length,
      winnerMerges: merges.length,
      replayable: list.filter((r) => r.classification !== "indeterminate")
        .length,
      replayableWinnerMerges: merges.filter(
        (r) => r.classification !== "indeterminate",
      ).length,
      winnerMergeReplayableRate: pct(
        merges.filter((r) => r.classification !== "indeterminate").length,
        merges.length,
      ),
      founderKnown: list.filter((r) => r.anchorEntities !== null).length,
      indeterminateByReason: reasons,
    };
  };
  const post = records.filter((r) => eraOf(r) === "post_0044");
  const legacy = records.filter((r) => eraOf(r) === "legacy_or_unlinked");
  // closed world = post-0044 row whose candidate event is itself post-0044
  // (founder anchor captured). A post-0044 merge into a legacy candidate is
  // unrecoverable legacy debt, NOT a telemetry bug — keep the two apart:
  // telemetry quality is judged only inside the closed world.
  const closed = records.filter(
    (r) => eraOf(r) === "post_0044" && r.anchorEntities !== null,
  );
  return {
    post_0044: per(post),
    legacy_or_unlinked: per(legacy),
    closed_world: per(closed),
  };
}

/**
 * Promotion gate inputs (§3b.2a.4) — the gate is sample sufficiency, never
 * elapsed time. Reports the raw denominators; the decision stays manual.
 */
export function promotionGateInputs(
  records: ReplayRecord[],
  edges: DocEdge[],
  edgeGold: Map<string, EdgeGold>,
) {
  const goldOf = (d: DocEdge) => edgeGold.get(`${d.eventId}|${d.evId}`);
  const replayableEdges = edges.filter(
    (d) => d.rec.classification !== "indeterminate",
  );
  const rev = replayableEdges.filter((d) => goldOf(d));
  const era = coverageByEra(records);
  return {
    replayableDecisions: records.filter(
      (r) => r.classification !== "indeterminate",
    ).length,
    replayableWinnerMerges: era.post_0044.replayableWinnerMerges,
    reviewedReplayableEdges: rev.length,
    reviewedMisclusteredReplayable: rev.filter(
      (d) => goldOf(d) === "misclustered",
    ).length,
    reviewedOnTopicReplayable: rev.filter(
      (d) => goldOf(d) === "on_topic" || goldOf(d) === "driver",
    ).length,
    // the two denominators the decision branches actually need
    falseSplitDenominator: rev.filter((d) => goldOf(d) === "on_topic").length,
    poisoningCaptureDenominator: rev.filter((d) => goldOf(d) === "misclustered")
      .length,
    post0044WinnerMergeReplayableRate: era.post_0044.winnerMergeReplayableRate,
    // the honest telemetry-quality metric: merges where BOTH the decision
    // row and the candidate event are post-0044 — expected ~100%
    closedWorldWinnerMergeReplayableRate:
      era.closed_world.winnerMergeReplayableRate,
    closedWorldWinnerMerges: era.closed_world.winnerMerges,
  };
}

/**
 * Gold overlap sampling — rank post-0044 events for the next review round.
 * Priority: most accumulated non-founder context, then merge depth,
 * cross-language and semantic-path exposure, doc volume.
 */
export interface SamplingCandidate {
  eventId: string;
  merges: number;
  docs: number;
  paths: string[];
  xlangMerges: number;
  semanticMerges: number;
  founderSize: number | null;
  nonFounderEntityGrowth: number;
}
export function goldSampling(
  records: ReplayRecord[],
  limit = 12,
): SamplingCandidate[] {
  const byEvent = new Map<string, ReplayRecord[]>();
  for (const r of records) {
    if (
      eraOf(r) !== "post_0044" ||
      !r.winnerPair ||
      r.actualDecision !== "merge"
    )
      continue;
    const id = r.chosenEventId ?? r.candidateEventId;
    if (!id) continue;
    byEvent.set(id, [...(byEvent.get(id) ?? []), r]);
  }
  const out: SamplingCandidate[] = [];
  for (const [eventId, list] of byEvent) {
    const anchor = list.find((r) => r.anchorEntities !== null)?.anchorEntities;
    // growth = candidate context beyond the founder — computable for
    // indeterminate merges too (their candidate sets are still captured)
    const maxContext = Math.max(
      0,
      ...list.map((r) => {
        // anchor unknown → growth is unknowable, report 0 rather than
        // counting every candidate entity as non-founder
        if (r.actualCandidateEntitiesBefore === null || !anchor) return 0;
        const a = new Set(anchor);
        return r.actualCandidateEntitiesBefore.filter((e) => !a.has(e)).length;
      }),
    );
    const paths = [...new Set(list.map((r) => r.actualPath))];
    out.push({
      eventId,
      merges: list.length,
      docs: list.reduce((n, r) => n + r.attachedEvidenceVersionIds.length, 0),
      paths,
      xlangMerges: list.filter((r) => r.crossLanguage === true).length,
      semanticMerges: list.filter((r) => r.actualPath.startsWith("semantic"))
        .length,
      founderSize: anchor === undefined ? null : (anchor?.length ?? 0),
      nonFounderEntityGrowth: maxContext,
    });
  }
  return out
    .sort(
      (a, b) =>
        b.nonFounderEntityGrowth - a.nonFounderEntityGrowth ||
        b.merges - a.merges ||
        b.xlangMerges - a.xlangMerges ||
        b.semanticMerges - a.semanticMerges ||
        b.docs - a.docs ||
        a.eventId.localeCompare(b.eventId),
    )
    .slice(0, limit);
}
