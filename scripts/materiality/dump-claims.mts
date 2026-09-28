/* R7.1b — freeze a CLAIM-level corpus for the claim-materiality lab.
 *
 * Unit = logical claim (claims.current_version_id snapshot), not events.
 * Stratified: every economic-predicate claim we have (capped), plus a
 * deterministic md5-ordered slice of non-economic predicates for
 * negative space — a given DB snapshot always dumps the same claim IDs.
 *
 * Evidence stats reuse R6 canonical semantics: claim_evidence →
 * evidence_version → document → latest lineage parent walk → effective
 * root → root SOURCE (lib/db/read.ts effectiveRoots/latestLineage).
 * Never count cached origin_document_id — 'original' roots carry NULL.
 *
 *   DATABASE_URL=… npx tsx scripts/materiality/dump-claims.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

import { getPool } from "../../lib/db/pool.ts";
import { effectiveRoots, latestLineage } from "../../lib/db/read.ts";
import {
  resolveOriginSources,
  standingClaimPos,
} from "../../lib/db/adjudicate.ts";
import {
  latestVotes,
  positionsFromVotes,
  posKey,
  type Vote,
} from "../../lib/db/positions.ts";
import { toJsonb } from "../../lib/db/pool.ts";

const ECONOMIC_PREDICATES = [
  "interest_rate",
  "policy_rate",
  "base_rate",
  "refinancing_rate",
  "deposit_rate_cap",
  "exchange_rate",
  "tariff_rate",
  "tariff",
  "tariff_reduction",
  "tariff_reduction_value",
  "reciprocal_tariff",
  "trade_agreement",
  "trade_agreement_extension",
  "signed_agreement",
  "trade_deal",
  "sanctions",
  "sanction",
  "impose_sanctions",
  "lift_sanctions",
  "export_ban",
  "export_control",
  "export_regulation",
  "import_ban",
  "fiscal_spending",
  "government_spending",
  "stimulus",
  "fund_disbursement",
  "aid_disbursement",
  "military_aid",
  "military_aid_disbursement",
  "disbursement",
  "debt",
  "debt_to_gdp",
  "national_debt",
  "investment",
  "investment_commitment",
  "foreign_investment",
  "mo_rong_dau_tu",
  "net_profit",
  "profit",
  "revenue",
  "dividend",
  "stock_split",
  "buyback",
  "growth_pct",
  "gdp_growth",
  "inflation_rate",
  "unemployment_rate",
  "cpi",
  "money_usd",
  "money_vnd",
  "damage_usd",
  "price",
  "price_change",
];

const CAP_PER_PREDICATE = 30;
const NEGATIVE_SAMPLE = 120;
const METHOD_VERSION = "r7.1b";
const SELECTION_VERSION = "claims-v2";

/* ── canonical claim evidence stats ─────────────────────────── */

interface ClaimEvidenceStats {
  confirmedIndependentOrigins: number;
  primaryOrigins: number;
  unresolvedOrigins: number;
  derivedDocuments: number;
  rawSourceCount: number;
}

/* Evidence stats at the LOGICAL CLAIM grain, not the current version:
 * R6 mints truth-state versions (reported→supported) that carry no new
 * evidence, so current_version_id alone misses docs pinned to v1.
 *
 * Contract — same vote semantics as the batch adjudicator
 * (lib/db/adjudicate.ts), never a re-count:
 *   all claim_versions → claim_evidence
 *   → voter = lineage-root source (resolveOriginSources)
 *   → latest vote per voter (latestVotes, evidence time)
 *   → winner position (positionsFromVotes + rankWinner)
 *   → live standing docs = docs behind votes on the winning position
 *   → latestLineage closure + effectiveRoots over those docs */
async function getClaimEvidenceStats(
  claims: {
    claimId: string;
    currentValue: unknown;
    currentUnit: string | null;
    currentState: string;
  }[],
): Promise<Map<string, ClaimEvidenceStats>> {
  const db = getPool();
  const out = new Map<string, ClaimEvidenceStats>();
  const claimIds = claims.map((c) => c.claimId);
  if (!claimIds.length) return out;

  const { rows: versions } = await db.query<{
    claim_id: string;
    id: string;
    version_no: number;
    value: unknown;
    unit: string | null;
  }>(
    `SELECT claim_id, id, version_no, value, unit
       FROM claim_versions WHERE claim_id = ANY($1)`,
    [claimIds],
  );
  const versByClaim = new Map<string, typeof versions>();
  for (const v of versions)
    (
      versByClaim.get(v.claim_id) ??
      versByClaim.set(v.claim_id, []).get(v.claim_id)!
    ).push(v);

  // every evidence attachment across ALL versions of these claims
  const { rows: evRows } = await db.query<{
    claim_id: string;
    version_no: number;
    value: unknown;
    unit: string | null;
    strength: string | null;
    doc_id: string;
    source_id: string;
    vote_at: string;
  }>(
    `SELECT cv.claim_id, cv.version_no, cv.value, cv.unit,
            ce.evidence_strength AS strength,
            ed.id AS doc_id, ed.source_id,
            COALESCE(ed.published_at, ev.observed_at) AS vote_at
       FROM claim_evidence ce
       JOIN claim_versions cv ON cv.id = ce.claim_version_id
       JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
       JOIN evidence_documents ed ON ed.id = ev.document_id
      WHERE cv.claim_id = ANY($1)`,
    [claimIds],
  );
  if (!evRows.length) return out;

  /* lineage closure over every touched doc AND its ancestors — a root
   * outside the doc set must resolve, not count dangling */
  const edges = new Map<string, { parent: string | null; relation: string }>();
  let frontier = [...new Set(evRows.map((r) => r.doc_id))];
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const lin = await latestLineage(frontier);
    const next = new Set<string>();
    for (const [child, e] of lin) {
      edges.set(child, e);
      if (e.parent && !edges.has(e.parent)) next.add(e.parent);
    }
    frontier = [...next];
  }
  const touchedIds = new Set(evRows.map((r) => r.doc_id));
  for (const e of edges.values()) if (e.parent) touchedIds.add(e.parent);
  const { rows: docMeta } = await db.query<{
    doc_id: string;
    source_id: string;
    kind: string;
  }>(
    `SELECT ed.id AS doc_id, ed.source_id, s.kind::text AS kind
       FROM evidence_documents ed
       JOIN sources s ON s.id = ed.source_id
      WHERE ed.id = ANY($1)`,
    [[...touchedIds]],
  );
  const known = new Map(docMeta.map((d) => [d.doc_id, d]));

  // voter identity = lineage-root source — wire reprints collapse
  const originOf = await resolveOriginSources(db as never, [
    ...new Set(evRows.map((r) => r.doc_id)),
  ]);

  interface Evote extends Vote {
    docId: string;
  }
  const evByClaim = new Map<string, Evote[]>();
  for (const r of evRows) {
    const vote: Evote = {
      voter: originOf.get(r.doc_id) ?? r.source_id,
      pos: posKey(r.value, r.unit),
      valueJson: toJsonb(r.value),
      unit: r.unit,
      versionNo: r.version_no,
      state: "supported",
      /* same flag as the batch adjudicator — a 'direct' evidence row is
       * what lets a lone primary beat a publisher majority */
      primary: r.strength === "direct",
      at: Date.parse(r.vote_at),
      docId: r.doc_id,
    };
    (
      evByClaim.get(r.claim_id) ??
      evByClaim.set(r.claim_id, []).get(r.claim_id)!
    ).push(vote);
  }

  for (const c of claims) {
    const claimId = c.claimId;
    const vers = (versByClaim.get(claimId) ?? []).map((v) => ({
      id: v.id,
      version_no: v.version_no,
      pos: posKey(v.value, v.unit),
      valueJson: toJsonb(v.value),
    }));
    // latestVotes preserves our objects (docId survives the Vote type)
    const latest = latestVotes(evByClaim.get(claimId) ?? []) as Map<
      string,
      Evote
    >;
    /* Authority-protected truth (confirmed/corrected/retracted/
     * unresolved) is NOT re-ranked — an old publisher majority cannot
     * re-root a corrected value. Mutable states take canonical
     * rankWinner. Shared helper keeps R6/R7 on one rule. */
    const standingPos = standingClaimPos({
      positions: [...positionsFromVotes(latest, vers).values()],
      currentPos: posKey(c.currentValue, c.currentUnit),
      currentState: c.currentState,
    });
    // live standing docs = the docs behind each voter's latest vote,
    // restricted to votes standing on the standing position — a source
    // whose latest assertion moved elsewhere no longer counts here
    const standingDocs = [
      ...new Set(
        [...latest.values()]
          .filter((v) => v.pos === standingPos)
          .map((v) => v.docId),
      ),
    ]
      .map((id) => known.get(id))
      .filter((d): d is NonNullable<typeof d> => d != null);
    const stats = effectiveRoots(standingDocs, edges, known);
    out.set(claimId, {
      confirmedIndependentOrigins: stats.confirmedIndependentOrigins,
      primaryOrigins: stats.primaryOrigins,
      unresolvedOrigins: stats.unresolvedOrigins,
      derivedDocuments: stats.derivedDocuments,
      rawSourceCount: new Set(standingDocs.map((d) => d.source_id)).size,
    });
  }
  return out;
}

/* ── dump ───────────────────────────────────────────────────── */

async function main() {
  const db = getPool();

  // deterministic negative slice: md5 order, not random()
  const sql = `
WITH picked AS (
  SELECT c.id,
         row_number() OVER (PARTITION BY c.predicate ORDER BY c.id) rn,
         c.predicate IN (SELECT unnest($1::text[])) econ
  FROM claims c
),
chosen AS (
  SELECT id FROM picked WHERE econ AND rn <= $2
  UNION
  SELECT id FROM (
    SELECT id FROM picked WHERE NOT econ ORDER BY md5(id::text) LIMIT $3
  ) neg
)
SELECT
  c.id AS claim_id,
  c.event_id,
  c.predicate,
  c.claim_type,
  c.subject_entity_id,
  cv.id             AS version_id,
  cv.value,
  cv.value_type,
  cv.unit,
  cv.qualifiers,
  cv.state,
  cv.valid_from::text AS valid_from,
  pv.id             AS prev_version_id,
  pv.value          AS prev_value,
  pv.unit           AS prev_unit,
  pv.state          AS prev_state
FROM chosen z
JOIN claims c ON c.id = z.id
JOIN claim_versions cv ON cv.id = c.current_version_id
LEFT JOIN claim_versions pv ON pv.id = cv.previous_version_id
ORDER BY c.id`;

  const { rows } = await db.query(sql, [
    ECONOMIC_PREDICATES,
    CAP_PER_PREDICATE,
    NEGATIVE_SAMPLE,
  ]);

  const statsMap = await getClaimEvidenceStats(
    rows.map((r) => ({
      claimId: r.claim_id,
      currentValue: r.value,
      currentUnit: r.unit,
      currentState: r.state,
    })),
  );

  const items = rows.map((r) => {
    const ev = statsMap.get(r.claim_id);
    return {
      claimId: r.claim_id,
      eventId: r.event_id,
      predicate: r.predicate,
      claimType: r.claim_type,
      current: {
        versionId: r.version_id,
        value: r.value,
        valueType: r.value_type,
        unit: r.unit,
        qualifiers: r.qualifiers,
        state: r.state,
        validFrom: r.valid_from,
      },
      /* truth-history only — previous_version_id records the prior TRUTH
       * state of this proposition, never an economic prior period.
       * Prod claims carry no structured from→to yet, so
       * economicComparison stays null and rates/tariffs score as
       * level observations until a real comparison is bound. */
      previousVersion: r.prev_version_id
        ? {
            versionId: r.prev_version_id,
            value: r.prev_value,
            unit: r.prev_unit,
            state: r.prev_state,
          }
        : null,
      economicComparison: null,
      /* prod reality: no entities table is bound yet and
       * subject_entity_id is NULL on every claim — canonicalKey/type/
       * countryCode stay null and the qualifier text carries the load */
      subject: {
        entityId: r.subject_entity_id,
        canonicalKey: null,
        type: null,
        countryCode: null,
        qualifierText: r.qualifiers?.subject ?? null,
      },
      evidence: {
        claimState: r.state,
        confirmedIndependentOrigins: ev?.confirmedIndependentOrigins ?? 0,
        primaryOrigins: ev?.primaryOrigins ?? 0,
        unresolvedOrigins: ev?.unresolvedOrigins ?? 0,
        derivedDocuments: ev?.derivedDocuments ?? 0,
        rawSourceCount: ev?.rawSourceCount ?? 0,
      },
      sourceSet: "holdout",
    };
  });

  const idsHash = createHash("sha256")
    .update(items.map((i) => i.claimId).join("\n"))
    .digest("hex")
    .slice(0, 16);

  const corpus = {
    generatedAt: new Date().toISOString(),
    methodVersion: METHOD_VERSION,
    selectionVersion: SELECTION_VERSION,
    claimCount: items.length,
    idsHash,
    items,
  };

  writeFileSync(
    "tests/fixtures/materiality-claims-corpus.json",
    JSON.stringify(corpus, null, 2) + "\n",
  );
  console.log(
    `wrote ${items.length} claims → tests/fixtures/materiality-claims-corpus.json (idsHash ${idsHash})`,
  );
  const dist = { origins0: 0, origins1: 0, originsN: 0, unresolved: 0 };
  for (const i of items) {
    if (i.evidence.confirmedIndependentOrigins === 0) dist.origins0++;
    else if (i.evidence.confirmedIndependentOrigins === 1) dist.origins1++;
    else dist.originsN++;
    if (i.evidence.unresolvedOrigins > 0) dist.unresolved++;
  }
  console.log("evidence sanity:", dist);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
