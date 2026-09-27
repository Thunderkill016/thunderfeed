/* Claim adjudication — the batch pass that recomputes claim truth once
 * evidence has accumulated.
 *
 * R6.1 correction: this is the SAME truth engine the ingest writer runs
 * (lib/db/positions.ts), fed the SAME inputs — not a simpler side
 * implementation. The only differences are scope and voter identity:
 *
 *   scope   — all claim_versions of the logical claim, never just the
 *             synthesized current version (standing versions often carry
 *             no direct claim_evidence; the evidence lives on earlier
 *             assertion versions)
 *   voter   — LINEAGE ROOT source, not the reprinting outlet. A wire
 *             reprinted by 15 outlets is one origin; evidence collapsed
 *             to its effective root via evidence_lineage
 *
 *   state   — mints 'supported' / 'disputed' only. NEVER 'confirmed':
 *             confirmation is an authority act that happens at ingest
 *             (primary/direct evidence). If reconstruction finds a
 *             primary-backed winner, the claim mints 'supported' with
 *             the reason preserved — the audit log must not record a
 *             confirmation ceremony that never happened.
 *             'unresolved' is never minted by age — absence of
 *             corroboration is not uncertainty.
 *
 * Writes are APPEND-ONLY: adjudication mints a new claim_versions row
 * (version_no+1, same value, new state) — triggers reject UPDATE.
 * Re-runs are idempotent (computed == current → skip).
 */
import type pg from "pg";
import { getPool, toJsonb } from "./pool";
import { contentHash } from "./writer";
import { latestLineage } from "./read";
import {
  computeClaimState,
  latestVotes,
  positionsFromVotes,
  posKey,
  rankWinner,
  type Vote,
} from "./positions";

/* change_type on claim_versions is claim_change_type (has 'supported',
 * 'disputed' since 0037); changes.type gets the audit-grade record. */
const CHANGE_RECORD: Record<string, string> = {
  supported: "claim_supported",
  disputed: "claim_disputed",
};

interface ClaimRow {
  claim_id: string;
  event_id: string;
  state: string;
}

interface VersionRow {
  claim_id: string;
  id: string;
  version_no: number;
  value: unknown;
  unit: string | null;
  value_type: string;
  state: string;
}

interface EvRow {
  claim_id: string;
  version_id: string;
  version_no: number;
  value: unknown;
  unit: string | null;
  state: string;
  strength: string | null;
  stance: string;
  doc_id: string;
  source_id: string;
  vote_at: string;
}

/**
 * Resolve each doc's lineage-root SOURCE id — the voter identity. A doc
 * with no derived lineage votes as its own source; a wire rewrite votes
 * as the root's source (collapses reprints into one origin).
 */
async function resolveOriginSources(
  client: pg.PoolClient | pg.Pool,
  docIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!docIds.length) return out;
  const { rows: docs } = await client.query<{
    doc_id: string;
    source_id: string;
  }>(
    `SELECT ed.id AS doc_id, ed.source_id
       FROM evidence_documents ed WHERE ed.id = ANY($1)`,
    [docIds],
  );
  const srcOf = new Map(docs.map((d) => [d.doc_id, d.source_id]));
  /* lineage closure — roots may sit outside this doc set; fetch their
   * source ids too so votes resolve to the true origin */
  const latestLin = await latestLineage(docIds);
  let frontier = [
    ...new Set(
      [...latestLin.values()]
        .map((e) => e.parent)
        .filter((p): p is string => !!p && !srcOf.has(p)),
    ),
  ];
  while (frontier.length) {
    const { rows: extra } = await client.query<{
      doc_id: string;
      source_id: string;
    }>(
      `SELECT ed.id AS doc_id, ed.source_id
         FROM evidence_documents ed WHERE ed.id = ANY($1)`,
      [frontier],
    );
    if (!extra.length) break;
    for (const d of extra) srcOf.set(d.doc_id, d.source_id);
    const next = await latestLineage(frontier);
    for (const [k, v] of next) if (!latestLin.has(k)) latestLin.set(k, v);
    frontier = [
      ...new Set(
        [...next.values()]
          .map((e) => e.parent)
          .filter((p): p is string => !!p && !srcOf.has(p)),
      ),
    ];
  }
  const DERIVED = new Set([
    "syndicated",
    "rewritten",
    "quoted",
    "press_release_based",
  ]);
  for (const id of docIds) {
    let cur = id;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const e = latestLin.get(cur);
      if (!e || !e.parent || !DERIVED.has(e.relation)) break;
      cur = e.parent;
    }
    out.set(id, srcOf.get(cur) ?? srcOf.get(id) ?? cur);
  }
  return out;
}

/** Adjudicate the claims of the given events. Returns minted decisions. */
export async function adjudicateEvents(
  eventIds: string[],
  opts: { dryRun?: boolean } = {},
): Promise<
  {
    claimId: string;
    eventId: string;
    from: string;
    to: string;
    reason: string;
  }[]
> {
  if (eventIds.length === 0) return [];
  const pool = getPool();
  const nowMs = Date.now();

  /* scope: claims whose standing state is still 'reported' — adjudication
   * is a one-way escalation; terminal/adjudicated states are settled */
  const { rows: claims } = await pool.query<ClaimRow>(
    `SELECT c.id AS claim_id, c.event_id, cv.state
       FROM claims c
       JOIN claim_versions cv ON cv.id = c.current_version_id
      WHERE c.event_id = ANY($1) AND cv.state = 'reported'`,
    [eventIds],
  );
  if (!claims.length) return [];
  const claimIds = claims.map((r) => r.claim_id);

  const { rows: versions } = await pool.query<VersionRow>(
    `SELECT claim_id, id, version_no, value, unit, value_type, state
       FROM claim_versions WHERE claim_id = ANY($1)
      ORDER BY version_no`,
    [claimIds],
  );

  /* ALL claim_evidence across ALL versions — the logical claim is the
   * unit of truth; evidence pinned to v1 still counts after v3 stands */
  const { rows: evRows } = await pool.query<EvRow>(
    `SELECT cv.claim_id, ce.claim_version_id AS version_id, cv.version_no,
            cv.value, cv.unit, cv.state,
            ce.evidence_strength AS strength, ce.stance,
            ed.id AS doc_id, ed.source_id,
            COALESCE(ed.published_at, ev.observed_at) AS vote_at
       FROM claim_evidence ce
       JOIN claim_versions cv ON cv.id = ce.claim_version_id
       JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
       JOIN evidence_documents ed ON ed.id = ev.document_id
      WHERE cv.claim_id = ANY($1)`,
    [claimIds],
  );

  const originOf = await resolveOriginSources(pool as pg.Pool, [
    ...new Set(evRows.map((r) => r.doc_id)),
  ]);

  const versByClaim = new Map<string, VersionRow[]>();
  for (const v of versions) {
    if (!versByClaim.has(v.claim_id)) versByClaim.set(v.claim_id, []);
    versByClaim.get(v.claim_id)!.push(v);
  }
  const evByClaim = new Map<string, EvRow[]>();
  for (const r of evRows) {
    if (!evByClaim.has(r.claim_id)) evByClaim.set(r.claim_id, []);
    evByClaim.get(r.claim_id)!.push(r);
  }

  const decisions: {
    claimId: string;
    eventId: string;
    from: string;
    to: string;
    reason: string;
  }[] = [];
  for (const c of claims) {
    const vers = versByClaim.get(c.claim_id) ?? [];
    const votes: Vote[] = (evByClaim.get(c.claim_id) ?? []).map((r) => ({
      voter: originOf.get(r.doc_id) ?? r.source_id,
      pos: posKey(r.value, r.unit),
      valueJson: toJsonb(r.value),
      unit: r.unit,
      versionNo: r.version_no,
      state: r.state,
      primary: r.strength === "direct",
      at: Date.parse(r.vote_at),
    }));
    const positions = positionsFromVotes(
      latestVotes(votes),
      vers.map((v) => ({
        id: v.id,
        version_no: v.version_no,
        pos: posKey(v.value, v.unit),
        valueJson: toJsonb(v.value),
      })),
    );
    const winner = rankWinner([...positions.values()]);
    const winnerVer = winner
      ? vers.find((v) => v.id === winner.versionId)
      : undefined;
    let to = computeClaimState({
      positions: [...positions.values()],
      winnerVersionState: winnerVer?.state,
    });
    /* batch adjudication never mints 'confirmed' — confirmation is an
     * ingest-time authority act; a primary-backed winner reconstructed
     * here escalates to 'supported' with the reason on the audit row */
    const reason =
      to === "confirmed"
        ? "primary_origin_seen"
        : to === "disputed"
          ? "live_positions"
          : "independent_corroboration";
    if (to === "confirmed") to = "supported";
    if (to === c.state) continue;
    decisions.push({
      claimId: c.claim_id,
      eventId: c.event_id,
      from: c.state,
      to,
      reason,
    });
  }

  if (opts.dryRun || decisions.length === 0) return decisions;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const d of decisions) {
      await mintClaimState(client, d, nowMs);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return decisions;
}

/* Mint version_no+1 carrying the new state; identical value, so the diff
 * readers see is purely the truth-state move. */
async function mintClaimState(
  client: pg.PoolClient,
  d: { claimId: string; eventId: string; to: string; reason: string },
  nowMs: number,
): Promise<void> {
  const cur = await client.query<{
    id: string;
    version_no: number;
    value_type: string;
    value: unknown;
    unit: string | null;
    qualifiers: unknown;
    valid_from: string | null;
    content_hash: string;
    predicate: string;
  }>(
    `SELECT cv.id, cv.version_no, cv.value_type, cv.value::text AS value,
            cv.unit, cv.qualifiers, cv.valid_from, cv.content_hash,
            c.predicate
     FROM claims c JOIN claim_versions cv ON cv.id = c.current_version_id
     WHERE c.id = $1`,
    [d.claimId],
  );
  const cv = cur.rows[0];
  if (!cv) return;

  const newVn = cv.version_no + 1;
  const { rows: minted } = await client.query<{ id: string }>(
    `INSERT INTO claim_versions
       (claim_id, version_no, value_type, value, unit, qualifiers, state,
        valid_from, observed_at, previous_version_id, change_type,
        content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      d.claimId,
      newVn,
      cv.value_type,
      cv.value,
      cv.unit,
      cv.qualifiers,
      d.to,
      cv.valid_from,
      new Date(nowMs).toISOString(),
      cv.id,
      /* change_type carries the exact new state — supported is NOT
       * written as 'confirmed' anymore (0037 added the enum values) */
      d.to,
      contentHash(d.claimId, `adjudicate:${d.to}:${newVn}`),
    ],
  );
  await client.query(
    `UPDATE claims SET current_version_id = $2, last_seen_at = now()
     WHERE id = $1`,
    [d.claimId, minted[0].id],
  );
  /* audit trail — a low-materiality change row so the transition is
   * visible in the ledger without spamming the WHAT CHANGED feed */
  const ev = await client.query<{ id: string }>(
    `SELECT current_version_id AS id FROM events WHERE id = $1`,
    [d.eventId],
  );
  await client.query(
    `INSERT INTO changes
       (event_id, claim_id, to_event_version_id, to_claim_version_id,
        type, materiality, summary, detected_at)
     VALUES ($1, $2, $3, $4, $5, 'low', $6, $7)`,
    [
      d.eventId,
      d.claimId,
      ev.rows[0]?.id ?? null,
      minted[0].id,
      CHANGE_RECORD[d.to] ?? "claim_updated",
      `${cv.predicate} — reported → ${d.to} (${d.reason})`,
      new Date(nowMs).toISOString(),
    ],
  );
}
