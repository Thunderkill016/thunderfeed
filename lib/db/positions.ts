/* Claim truth primitives — shared by the ingest writer and the batch
 * adjudicator so "what does the accumulated evidence say" has ONE answer
 * in the codebase.
 *
 *   posKey            — position identity (value+unit; a unit change is
 *                       a different fact, never one position)
 *   latestVotes       — one vote per origin, newest by evidence time
 *   positionsFromVotes— origins grouped by the position they stand on
 *   rankWinner        — deterministic standing position
 *   computeClaimState — the single state decider:
 *       sole terminal position          → corrected/retracted
 *       winner has a primary origin     → confirmed
 *       >1 live positions               → disputed
 *       ≥2 independent origins          → supported
 *       otherwise                       → reported
 *
 *   The caller supplies the voter key — the ingest path votes by source
 *   name, the batch adjudicator by LINEAGE ROOT source (a wire reprint
 *   can never corroborate its own wire). Both feed the same decider.
 *   'unresolved' is deliberately not derived: it is reserved for
 *   analyst/manual flagging of contested ambiguity, and age alone never
 *   changes truth.
 */
import { canonValue, toJsonb } from "./pool";

/** Position identity — value + unit, canonicalized exactly as the ingest
 *  writer does (canonValue normalizes '4' vs 4). */
export function posKey(
  value: unknown,
  unit: string | null | undefined,
): string {
  return toJsonb({ v: canonValue(value) ?? null, u: unit || null });
}

export interface Vote {
  /** voter identity — source name at ingest, origin source id in batch */
  voter: string;
  pos: string;
  valueJson: string;
  unit: string | null;
  versionNo: number;
  state: string;
  /** doc carried direct/primary evidence for this position */
  primary: boolean;
  at: number;
}

/** Latest assertion per voter — evidence time, never ingestion order. */
export function latestVotes(rows: Vote[]): Map<string, Vote> {
  const out = new Map<string, Vote>();
  const sorted = [...rows].sort(
    (a, b) => a.at - b.at || a.versionNo - b.versionNo,
  );
  for (const v of sorted) out.set(v.voter, v);
  return out;
}

export interface Position {
  pos: string;
  /** id/version of the newest claim_version standing on this position */
  versionId: string;
  versionNo: number;
  valueJson: string;
  /** independent origins currently standing on this position */
  origins: Set<string>;
  hasPrimary: boolean;
  latestAt: number;
  latestPrimaryAt: number;
}

export function positionsFromVotes(
  latest: Map<string, Vote>,
  versions: {
    id: string;
    version_no: number;
    pos: string;
    valueJson: string;
  }[],
): Map<string, Position> {
  const positions = new Map<string, Position>();
  for (const ver of versions) {
    const p =
      positions.get(ver.pos) ??
      ({
        pos: ver.pos,
        valueJson: ver.valueJson,
        versionId: ver.id,
        versionNo: 0,
        origins: new Set(),
        hasPrimary: false,
        latestAt: 0,
        latestPrimaryAt: 0,
      } satisfies Position);
    if (ver.version_no > p.versionNo) {
      p.versionId = ver.id;
      p.versionNo = ver.version_no;
    }
    positions.set(ver.pos, p);
  }
  for (const vote of latest.values()) {
    const p = positions.get(vote.pos);
    if (!p) continue;
    p.origins.add(vote.voter);
    if (vote.primary) {
      p.hasPrimary = true;
      p.latestPrimaryAt = Math.max(p.latestPrimaryAt, vote.at);
    }
    p.latestAt = Math.max(p.latestAt, vote.at);
  }
  return positions;
}

/** Deterministic winner: primary positions first (latest primary time),
 *  then the position with most independent origins. Never order-dependent. */
export function rankWinner(positions: Position[]): Position | null {
  const live = positions.filter((p) => p.origins.size > 0);
  /* every origin retracted — fall back to the newest position so the
   * claim still has a standing version (the retraction itself) */
  const ranked = live.length ? live : positions;
  if (!ranked.length) return null;
  const primary = ranked.filter((p) => p.hasPrimary);
  return primary.length
    ? primary.sort(
        (a, b) =>
          b.latestPrimaryAt - a.latestPrimaryAt ||
          a.valueJson.localeCompare(b.valueJson),
      )[0]
    : ranked.sort(
        (a, b) =>
          b.origins.size - a.origins.size ||
          a.valueJson.localeCompare(b.valueJson),
      )[0];
}

export function computeClaimState(opts: {
  positions: Position[];
  /** state on the winner's current version (terminal check) */
  winnerVersionState?: string | null;
}): "confirmed" | "disputed" | "supported" | "reported" | string {
  const { positions } = opts;
  if (!positions.length) return "reported";
  const live = positions.filter((p) => p.origins.size > 0);
  const winner = rankWinner(positions);
  if (!winner) return "reported";
  if (
    live.length === 1 &&
    (opts.winnerVersionState === "corrected" ||
      opts.winnerVersionState === "retracted")
  ) {
    return opts.winnerVersionState;
  }
  if (winner.hasPrimary) return "confirmed";
  if (live.length > 1) return "disputed";
  if (winner.origins.size >= 2) return "supported";
  return "reported";
}
