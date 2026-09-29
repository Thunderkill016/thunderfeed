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
