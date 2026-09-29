/**
 * R7.1d.3b.2 — shared replay-corpus primitives so the dump script and the
 * regression tests exercise the SAME canonicalization.
 *
 * - groupProvenanceEdges: folds N doc-level provenance rows into ONE
 *   replay unit per resolver decision (spec §3.2). A disagreeing group is
 *   flagged groupInvariantViolation — never majority-voted.
 * - replayCorpusHash: deterministic semantic hash over replay records —
 *   generatedAt-independent, shuffle-stable (all sets sorted).
 */
import { createHash } from "node:crypto";

export interface ProvenanceEdgeLike {
  resolver_decision_id: string;
  event_id: string;
  evidence_version_id: string;
  decision: string;
  path: string;
  incoming_cluster: string | null;
  candidate_event_id: string | null;
  score: number | null;
  candidate_signature_hash_before: string | null;
  candidate_entities_before: string[] | null;
  candidate_core_entities_before: string[] | null;
  incoming_entities: string[] | null;
  incoming_core_entities: string[] | null;
  cross_language: boolean | null;
  explanation: Record<string, unknown> | null;
  created_at: string;
}

export interface WinnerGroup {
  decisionId: string;
  eventId: string;
  evidenceVersionIds: string[];
  edge: ProvenanceEdgeLike;
  invariantOk: boolean;
}

const sorted = (a: string[]) => [...a].sort();
const canonArr = (v: string[] | null) =>
  v === null ? null : JSON.stringify(sorted(v));

export function groupProvenanceEdges(edges: ProvenanceEdgeLike[]): {
  winners: WinnerGroup[];
  groupInvariantFailures: number;
} {
  const groups = new Map<string, ProvenanceEdgeLike[]>();
  for (const e of edges) {
    const g = groups.get(e.resolver_decision_id) ?? [];
    g.push(e);
    groups.set(e.resolver_decision_id, g);
  }
  let groupInvariantFailures = 0;
  const winners: WinnerGroup[] = [];
  for (const [did, g] of groups) {
    const e0 = g[0];
    const invariantOk = g.every(
      (e) =>
        e.event_id === e0.event_id &&
        e.incoming_cluster === e0.incoming_cluster &&
        e.decision === e0.decision &&
        e.path === e0.path &&
        e.candidate_event_id === e0.candidate_event_id &&
        canonArr(e.candidate_entities_before) ===
          canonArr(e0.candidate_entities_before) &&
        canonArr(e.candidate_core_entities_before) ===
          canonArr(e0.candidate_core_entities_before) &&
        canonArr(e.incoming_entities) === canonArr(e0.incoming_entities) &&
        canonArr(e.incoming_core_entities) ===
          canonArr(e0.incoming_core_entities) &&
        e.candidate_signature_hash_before ===
          e0.candidate_signature_hash_before &&
        JSON.stringify(e.explanation) === JSON.stringify(e0.explanation),
    );
    if (!invariantOk) groupInvariantFailures++;
    winners.push({
      decisionId: did,
      eventId: e0.event_id,
      evidenceVersionIds: g.map((e) => e.evidence_version_id).sort(),
      edge: e0,
      invariantOk,
    });
  }
  return { winners, groupInvariantFailures };
}

/**
 * anchor(E) = incoming entity sets of E's create_new_event provenance —
 * the immutable founding identity. A create row with NULL sets (written
 * before 0044 captured them) yields a known-present-but-unknown anchor:
 * the event exists in anchors with null sets, which downstream treats as
 * missing_founder_anchor — never backfilled from accumulated state.
 */
export function deriveAnchors(
  winners: WinnerGroup[],
): Map<string, { entities: string[] | null; core: string[] | null }> {
  const anchors = new Map<
    string,
    { entities: string[] | null; core: string[] | null }
  >();
  for (const w of winners) {
    if (w.edge.decision !== "create") continue;
    anchors.set(w.eventId, {
      entities: w.edge.incoming_entities,
      core: w.edge.incoming_core_entities,
    });
  }
  return anchors;
}

/** deterministic semantic hash — every array sorted, every object key-sorted */
export function replayCorpusHash(records: Record<string, unknown>[]): string {
  const deepSort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(deepSort);
      // sort arrays of scalars; keep object arrays in stable key order
      return items.every((i) => typeof i !== "object" || i === null)
        ? [...items].sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          )
        : items;
    }
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .map(([k, val]) => [k, deepSort(val)] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    return v;
  };
  // record order must not matter — key by decision id before hashing
  const canonical = records
    .map(deepSort)
    .sort((a, b) =>
      JSON.stringify(
        (a as Record<string, unknown>).resolverDecisionId,
      ).localeCompare(
        JSON.stringify((b as Record<string, unknown>).resolverDecisionId),
      ),
    );
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}
