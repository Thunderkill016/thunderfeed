/* Claim adjudication — the batch pass that turns 'reported' claims into
 * supported / disputed / unresolved once evidence has accumulated.
 *
 * Runs AFTER ingest (writer.ts already adjudicates per-assertion at write
 * time; this pass adjudicates claims whose evidence arrived later or
 * whose state was never revisited). Deterministic rules only — no AI.
 *
 * State changes are APPEND-ONLY: adjudication mints a new claim_versions
 * row (version_no+1, same value, new state) — claim_versions triggers
 * reject UPDATE. Terminal states (corrected/retracted/confirmed/disputed)
 * are never touched: adjudication is a one-way escalation from reported,
 * and re-runs are idempotent.
 */
import type pg from "pg";
import { getPool } from "./pool";
import { contentHash } from "./writer";

/* claim_change_type has no 'supported'/'unresolved' member — map to the
 * nearest semantic record: corroborated→confirmed, disputed→disputed,
 * aged-out unresolved→disputed (it describes evidence standing, not a
 * content change). The real state lives on claim_versions.state. */
const ADJUDICATION_CHANGE_TYPE: Record<string, string> = {
  supported: "confirmed",
  disputed: "disputed",
  unresolved: "disputed",
};
const ADJUDICATION_CHANGE_RECORD: Record<string, string> = {
  supported: "claim_confirmed",
  disputed: "claim_disputed",
  unresolved: "claim_updated",
};

/* A claim whose ONLY evidence is a single source and that has had 5 days
 * to attract corroboration is 'unresolved' rather than forever 'reported'. */
export const STALE_REPORTED_DAYS = 5;
/* Corroboration threshold: ≥2 INDEPENDENT origins (independence_key
 * collapses wire reprints into one origin) before 'supported'. */
export const SUPPORT_QUORUM = 2;

export interface AdjudicationInput {
  /** current claim_versions.state — adjudicator only moves 'reported' */
  state: string;
  /** distinct evidence origins (independence groups) with stance=supports */
  independentSupports: number;
  /** distinct evidence origins with stance=contradicts */
  independentContradicts: number;
  /** any 'corrects' stance — the version chain owns those claims */
  hasCorrects: boolean;
  observedAtMs: number;
  nowMs: number;
}

/** The deterministic rule table — returns the new state or null to keep. */
export function decideAdjudication(
  i: AdjudicationInput,
): { to: string; reason: string } | null {
  if (i.state !== "reported") return null;
  if (i.hasCorrects) return null; // correction chain resolves it
  if (i.independentContradicts > 0) {
    return i.independentSupports > 0
      ? { to: "unresolved", reason: "support_and_contradiction" }
      : { to: "disputed", reason: "contradicted_uncorroborated" };
  }
  if (i.independentSupports >= SUPPORT_QUORUM) {
    return { to: "supported", reason: "independent_corroboration" };
  }
  const ageDays = (i.nowMs - i.observedAtMs) / 86_400_000;
  if (ageDays > STALE_REPORTED_DAYS) {
    return { to: "unresolved", reason: "aged_single_source" };
  }
  return null;
}

interface ClaimRow {
  claim_id: string;
  event_id: string;
  version_id: string;
  state: string;
  observed_at: string;
  sup: string;
  con: string;
  cor: string;
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
  const { rows } = await pool.query<ClaimRow>(
    `SELECT c.id AS claim_id, c.event_id, cv.id AS version_id,
            cv.state, cv.observed_at,
            COUNT(DISTINCT COALESCE(ed.independence_key, ed.source_id::text))
              FILTER (WHERE ce.stance = 'supports')    AS sup,
            COUNT(DISTINCT COALESCE(ed.independence_key, ed.source_id::text))
              FILTER (WHERE ce.stance = 'contradicts') AS con,
            COUNT(*) FILTER (WHERE ce.stance = 'corrects') AS cor
     FROM claims c
     JOIN claim_versions cv ON cv.id = c.current_version_id
     LEFT JOIN claim_evidence ce ON ce.claim_version_id = cv.id
     LEFT JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
     LEFT JOIN evidence_documents ed ON ed.id = ev.document_id
     WHERE c.event_id = ANY($1) AND cv.state = 'reported'
     GROUP BY c.id, c.event_id, cv.id, cv.state, cv.observed_at`,
    [eventIds],
  );

  const decisions = rows
    .map((r) => {
      const d = decideAdjudication({
        state: r.state,
        independentSupports: Number(r.sup),
        independentContradicts: Number(r.con),
        hasCorrects: Number(r.cor) > 0,
        observedAtMs: Date.parse(r.observed_at),
        nowMs,
      });
      return d
        ? {
            claimId: r.claim_id,
            eventId: r.event_id,
            from: r.state,
            to: d.to,
            reason: d.reason,
          }
        : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

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
      ADJUDICATION_CHANGE_TYPE[d.to] ?? "value_changed",
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
      ADJUDICATION_CHANGE_RECORD[d.to] ?? "claim_updated",
      `${cv.predicate} — reported → ${d.to} (${d.reason})`,
      new Date(nowMs).toISOString(),
    ],
  );
}
