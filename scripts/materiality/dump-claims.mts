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

async function getClaimEvidenceStats(
  claimVersionIds: string[],
): Promise<Map<string, ClaimEvidenceStats>> {
  const db = getPool();
  const out = new Map<string, ClaimEvidenceStats>();
  if (!claimVersionIds.length) return out;

  // claim_version → backing documents
  const { rows: docRows } = await db.query<{
    claim_version_id: string;
    doc_id: string;
  }>(
    `SELECT ce.claim_version_id, ev.document_id AS doc_id
       FROM claim_evidence ce
       JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
      WHERE ce.claim_version_id = ANY($1)`,
    [claimVersionIds],
  );
  const docsByCv = new Map<string, string[]>();
  for (const r of docRows)
    (
      docsByCv.get(r.claim_version_id) ??
      docsByCv.set(r.claim_version_id, []).get(r.claim_version_id)!
    ).push(r.doc_id);

  const allDocIds = [...new Set(docRows.map((r) => r.doc_id))];
  if (!allDocIds.length) return out;

  /* Lineage closure: fetch latest edges for the pool AND for every
   * parent the walk touches, so a root outside the claim's own docs is
   * resolved instead of counted dangling. effectiveRoots owns the
   * counting semantics — this only feeds it complete inputs. */
  const edges = new Map<string, { parent: string | null; relation: string }>();
  let frontier = allDocIds;
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const lin = await latestLineage(frontier);
    const next = new Set<string>();
    for (const [child, e] of lin) {
      edges.set(child, e);
      if (e.parent && !edges.has(e.parent)) next.add(e.parent);
    }
    frontier = [...next];
  }

  const touchedIds = new Set(allDocIds);
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

  for (const cvId of claimVersionIds) {
    const docIds = docsByCv.get(cvId) ?? [];
    const docs = docIds
      .map((id) => known.get(id))
      .filter((d): d is NonNullable<typeof d> => d != null);
    const stats = effectiveRoots(docs, edges, known);
    out.set(cvId, {
      confirmedIndependentOrigins: stats.confirmedIndependentOrigins,
      primaryOrigins: stats.primaryOrigins,
      unresolvedOrigins: stats.unresolvedOrigins,
      derivedDocuments: stats.derivedDocuments,
      rawSourceCount: new Set(docs.map((d) => d.source_id)).size,
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
  e.canonical_key   AS entity_key,
  e.entity_type,
  e.country_code,
  cv.id             AS version_id,
  cv.value,
  cv.value_type,
  cv.unit,
  cv.qualifiers,
  cv.state,
  cv.valid_from::text AS valid_from,
  pv.id             AS prev_version_id,
  pv.value          AS prev_value,
  pv.unit           AS prev_unit
FROM chosen z
JOIN claims c ON c.id = z.id
JOIN claim_versions cv ON cv.id = c.current_version_id
LEFT JOIN claim_versions pv ON pv.id = cv.previous_version_id
LEFT JOIN entities e ON e.id = c.subject_entity_id
ORDER BY c.id`;

  const { rows } = await db.query(sql, [
    ECONOMIC_PREDICATES,
    CAP_PER_PREDICATE,
    NEGATIVE_SAMPLE,
  ]);

  const statsMap = await getClaimEvidenceStats(rows.map((r) => r.version_id));

  const items = rows.map((r) => {
    const ev = statsMap.get(r.version_id);
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
      previous: r.prev_version_id
        ? {
            versionId: r.prev_version_id,
            value: r.prev_value,
            unit: r.prev_unit,
          }
        : null,
      subject: {
        entityId: r.subject_entity_id,
        canonicalKey: r.entity_key,
        type: r.entity_type,
        countryCode: r.country_code,
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
