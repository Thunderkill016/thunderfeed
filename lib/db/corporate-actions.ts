/* Corporate Actions — DB apply layer (pg-mem testable).
 *
 * Chain per provider claim:
 *   raw reference_observation (committed upstream, always survives)
 *     → assertion row (immutable; deduped by provider+key+fingerprint)
 *     → canonical action keyed (instrument_id, action_type, ex_date)
 *     → append-only version (correction/enrichment = +1, never UPDATE)
 *     → derivations: asserts | corroborates | conflicts
 *
 * Canonical authorship rule (documented, deterministic — not a silent
 * "truth picker"): the dedicated CA endpoint outranks EOD-derived
 * columns; equal-rank same-source changes are corrections (new version);
 * equal-rank cross-provider disagreement never rewrites canonical — the
 * assertion links with role='conflicts' and the divergence stays visible.
 */
import type { Pool } from "pg";
import {
  caDatasetRank,
  caDivergentFields,
  caFingerprint,
  caStatus,
  type CaAssertionInput,
  type CaSemantics,
} from "../corporate-actions";

type Q = Pick<Pool, "query">;

export type CaApplyOutcome =
  | "deduped" // identical provider+key+fingerprint already stored
  | "asserted" // new canonical action + version 1 created
  | "corroborated" // agrees with current canonical — linked, +0 version
  | "corrected" // authoritative change → version +1
  | "conflicted" // recorded disagreement — canonical untouched
  | "ambiguous"; // could not safely attach (see audit detail)

export interface CaApplyResult {
  outcome: CaApplyOutcome;
  assertionId: string;
  actionId: string | null;
  versionId: string | null;
  versionNo: number | null;
}

const CA_KIND_VI: Record<string, string> = {
  cash_dividend: "Cổ tức tiền mặt",
  stock_split: "Chia tách cổ phiếu",
};

const SEMANTIC_COLS = [
  "ex_date",
  "declaration_date",
  "record_date",
  "payment_date",
  "cash_amount",
  "currency",
  "split_from",
  "split_to",
  "split_factor",
] as const;

/** DATE → 'YYYY-MM-DD' — pg parses dates to local-midnight Date objects;
 *  local getters recover the market date without a UTC shift. */
const day = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

function rowToSemantics(r: Record<string, unknown>): CaSemantics & {
  fingerprint: string;
} {
  const s: CaSemantics = {
    exDate: day(r.ex_date) ?? "",
    declarationDate: day(r.declaration_date),
    recordDate: day(r.record_date),
    paymentDate: day(r.payment_date),
    cashAmount: r.cash_amount == null ? null : String(r.cash_amount),
    currency: (r.currency as string | null) ?? null,
    splitFrom: r.split_from == null ? null : String(r.split_from),
    splitTo: r.split_to == null ? null : String(r.split_to),
    splitFactor: r.split_factor == null ? null : String(r.split_factor),
    status: r.status === "cancelled" ? "cancelled" : "active",
  };
  return { ...s, fingerprint: caFingerprint(s) };
}

export async function applyActionAssertion(
  db: Q,
  a: CaAssertionInput,
): Promise<CaApplyResult> {
  // canonical status: provider's own status word maps via caStatus; when
  // the provider gives none, the parser's classification is trusted
  const status =
    a.providerStatus != null
      ? caStatus(a.providerStatus)
      : (a.status ?? "active");
  const fp = caFingerprint({ ...a, status });

  // 1. dedupe — same provider record + identical semantic fingerprint
  //    (a corrected provider payload shares the key but differs → new row)
  const existing = await db.query(
    `SELECT * FROM corporate_action_assertions
      WHERE provider=$1 AND dataset=$2 AND provider_record_key=$3`,
    [a.provider, a.dataset, a.providerRecordKey],
  );
  for (const row of existing.rows) {
    const efp = caFingerprint({
      ...rowToSemantics(row),
      status: caStatus(row.provider_status),
    });
    if (efp === fp)
      return {
        outcome: "deduped",
        assertionId: row.id,
        actionId: row.action_id,
        versionId: null,
        versionNo: null,
      };
  }

  // 2. canonical identity — canonical_key is derived deterministically:
  //    ca:<instrument-key>:<type>:<ex-date>
  const instr = await db.query(
    `SELECT canonical_key FROM financial_instruments WHERE id=$1`,
    [a.instrumentId],
  );
  if (!instr.rows.length) {
    // instrument must exist — assertions reference real identity only
    throw new Error(`instrument ${a.instrumentId} not found`);
  }
  const actionKey =
    `ca:${String(instr.rows[0].canonical_key).replace(/^instrument:/, "")}` +
    `:${a.actionType}:${a.exDate}`;

  // 3. reconcile — (instrument, type, ex_date) IS the key, so at most one
  //    candidate exists by construction
  const cand = await db.query(
    `SELECT id, status, current_version_id FROM corporate_actions
      WHERE canonical_key=$1`,
    [actionKey],
  );
  let actionId = (cand.rows[0]?.id as string | undefined) ?? null;
  const currentVersionId = cand.rows[0]?.current_version_id as
    string | undefined;

  // 4. decide role + version BEFORE inserting (assertions are immutable —
  //    action_id is written at insert time)
  const cur = currentVersionId
    ? (
        await db.query(`SELECT * FROM corporate_action_versions WHERE id=$1`, [
          currentVersionId,
        ])
      ).rows[0]
    : null;
  const curFp = cur ? rowToSemantics(cur).fingerprint : null;

  let outcome: CaApplyOutcome;
  let newVersionId: string | null = null;
  let newVersionNo: number | null = null;

  if (!actionId) {
    outcome = "asserted";
  } else if (curFp === fp) {
    outcome = "corroborated";
  } else {
    // disagreement vs current canonical — decide who authors
    const curSource = cur
      ? (
          await db.query(
            `SELECT provider, dataset FROM corporate_action_derivations d
               JOIN corporate_action_assertions a2 ON a2.id = d.assertion_id
              WHERE d.action_version_id=$1 AND d.role='asserts' LIMIT 1`,
            [cur.id],
          )
        ).rows[0]
      : null;
    const curRank = curSource ? caDatasetRank(curSource.dataset) : 0;
    const inRank = caDatasetRank(a.dataset);
    const sameSource =
      curSource &&
      curSource.provider === a.provider &&
      curSource.dataset === a.dataset;
    if (inRank > curRank || sameSource) {
      outcome = "corrected"; // authoritative change → version +1
    } else {
      // NULL-vs-value is absence, not disagreement — only fields BOTH
      // sides assert can conflict; partial agreement corroborates
      const divergent = caDivergentFields(
        { ...a, status },
        rowToSemantics(cur),
      );
      outcome = divergent.length ? "conflicted" : "corroborated";
    }
  }

  // 5. create action + insert assertion (atomically with caller's txn)
  const actionCreated = !actionId;
  if (!actionId) {
    const ins = await db.query(
      `INSERT INTO corporate_actions
         (canonical_key, instrument_id, action_type, status)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [actionKey, a.instrumentId, a.actionType, status],
    );
    actionId = ins.rows[0].id as string;
  }
  const arow = await db.query(
    `INSERT INTO corporate_action_assertions
       (instrument_id, source_listing_id, provider, dataset,
        provider_record_key, action_type, ex_date,
        declaration_date, record_date, payment_date,
        cash_amount, currency, split_from, split_to, split_factor,
        provider_status, action_id, observation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      a.instrumentId,
      a.sourceListingId,
      a.provider,
      a.dataset,
      a.providerRecordKey,
      a.actionType,
      a.exDate,
      a.declarationDate ?? null,
      a.recordDate ?? null,
      a.paymentDate ?? null,
      a.cashAmount ?? null,
      a.currency ?? null,
      a.splitFrom ?? null,
      a.splitTo ?? null,
      a.splitFactor ?? null,
      a.providerStatus ?? null,
      actionId,
      a.observationId,
    ],
  );
  const assertionId = arow.rows[0].id as string;

  // 6. version write when canonical state actually changes
  if (outcome === "asserted" || outcome === "corrected") {
    const prevNo = cur ? (cur.version_no as number) : 0;
    const v = await db.query(
      `INSERT INTO corporate_action_versions
         (action_id, version_no, ex_date, declaration_date, record_date,
          payment_date, cash_amount, currency, split_from, split_to,
          split_factor, status, observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        actionId,
        prevNo + 1,
        a.exDate,
        a.declarationDate ?? null,
        a.recordDate ?? null,
        a.paymentDate ?? null,
        a.cashAmount ?? null,
        a.currency ?? null,
        a.splitFrom ?? null,
        a.splitTo ?? null,
        a.splitFactor ?? null,
        status,
        a.observationId,
        cur?.id ?? null,
      ],
    );
    newVersionId = v.rows[0].id as string;
    newVersionNo = prevNo + 1;
    await db.query(
      `UPDATE corporate_actions
          SET current_version_id=$1, status=$2 WHERE id=$3`,
      [newVersionId, status, actionId],
    );
    // every attached assertion gets a derivation to the new version —
    // agrees → corroborates, disagrees → conflicts; the author asserts
    const rels = await db.query(
      `SELECT id, * FROM corporate_action_assertions WHERE action_id=$1`,
      [actionId],
    );
    for (const row of rels.rows) {
      const rfp = caFingerprint({
        ...rowToSemantics(row),
        status: caStatus(row.provider_status),
      });
      const role =
        row.id === assertionId
          ? "asserts"
          : rfp === fp
            ? "corroborates"
            : "conflicts";
      await db.query(
        `INSERT INTO corporate_action_derivations
           (action_id, action_version_id, assertion_id, observation_id, role)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (action_version_id, assertion_id, role) DO NOTHING`,
        [actionId, newVersionId, row.id, row.observation_id, role],
      );
    }
    // delta feed — a produced version IS the fact-change; bounded per
    // assertion so no baseline-flood guard needed like the macro layer
    const shortKey = actionKey.split(":")[1];
    await db.query(
      `INSERT INTO data_deltas
         (kind, materiality, summary, action_id,
          action_version_id, prev_action_version_id)
       VALUES ($1,'medium',$2,$3,$4,$5)
       ON CONFLICT (action_version_id) DO NOTHING`,
      [
        actionCreated ? "ca_declared" : "ca_updated",
        actionCreated
          ? `${CA_KIND_VI[a.actionType] ?? a.actionType} ${shortKey} · ex ${a.exDate} — ghi nhận mới`
          : `${CA_KIND_VI[a.actionType] ?? a.actionType} ${shortKey} · ex ${a.exDate} — sửa đổi v${prevNo + 1}`,
        actionId,
        newVersionId,
        cur?.id ?? null,
      ],
    );
  } else {
    // no version churn — link the assertion to the current version with
    // the verdict role (corroborated | conflicted)
    const role = outcome === "corroborated" ? "corroborates" : "conflicts";
    if (currentVersionId)
      await db.query(
        `INSERT INTO corporate_action_derivations
           (action_id, action_version_id, assertion_id, observation_id, role)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (action_version_id, assertion_id, role) DO NOTHING`,
        [actionId, currentVersionId, assertionId, a.observationId, role],
      );
  }

  return {
    outcome,
    assertionId,
    actionId,
    versionId: newVersionId ?? currentVersionId ?? null,
    versionNo: newVersionNo,
  };
}
