/* R7.1a — freeze a CLAIM-level corpus for the claim-materiality lab.
 *
 * Unit = logical claim (claims.current_version_id snapshot), not events.
 * Stratified: every economic-predicate claim we have (capped), plus a
 * random slice of non-economic predicates for negative space.
 *
 *   DATABASE_URL=… npx tsx scripts/materiality/dump-claims.mts
 */
import { readFileSync, writeFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

import { getPool } from "../../lib/db/pool.ts";

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
  "export_ban",
  "export_control",
  "export_regulation",
  "import_ban",
  "fiscal_spending",
  "government_spending",
  "stimulus",
  "fund_disbursement",
  "aid_disbursement",
  "disbursement",
  "debt",
  "debt_to_gdp",
  "national_debt",
  "investment",
  "investment_commitment",
  "foreign_investment",
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

async function main() {
  const db = getPool();

  const sql = `
WITH picked AS (
  SELECT c.id,
         row_number() OVER (PARTITION BY c.predicate ORDER BY c.last_seen_at DESC) rn,
         c.predicate IN (SELECT unnest($1::text[])) econ
  FROM claims c
),
chosen AS (
  SELECT id FROM picked WHERE econ AND rn <= $2
  UNION
  SELECT id FROM (
    SELECT id, random() r FROM picked WHERE NOT econ ORDER BY r LIMIT $3
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
  pv.unit           AS prev_unit,
  ind.origins    AS independent_origins,
  ind.primaries  AS primary_origins,
  ind.unresolved AS unresolved_origins
FROM chosen z
JOIN claims c ON c.id = z.id
JOIN claim_versions cv ON cv.id = c.current_version_id
LEFT JOIN claim_versions pv ON pv.id = cv.previous_version_id
LEFT JOIN entities e ON e.id = c.subject_entity_id
LEFT JOIN LATERAL (
  SELECT count(DISTINCT el.origin_document_id) AS origins,
         count(DISTINCT el.origin_document_id) FILTER (WHERE el.relation = 'original') AS primaries,
         count(DISTINCT el.origin_document_id) FILTER (WHERE el.relation = 'unknown') AS unresolved
  FROM claim_evidence ce
  JOIN evidence_versions evv ON evv.id = ce.evidence_version_id
  JOIN evidence_lineage el ON el.child_document_id = evv.document_id
    AND el.supersedes_lineage_id IS NULL
  WHERE ce.claim_version_id = cv.id
) ind ON true
ORDER BY c.predicate, c.last_seen_at DESC`;

  const { rows } = await db.query(sql, [
    ECONOMIC_PREDICATES,
    CAP_PER_PREDICATE,
    NEGATIVE_SAMPLE,
  ]);

  const corpus = rows.map((r) => ({
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
      primaryOrigins: Number(r.primary_origins ?? 0),
      independentOrigins: Number(r.independent_origins ?? 0),
      unresolvedOrigins: Number(r.unresolved_origins ?? 0),
    },
    sourceSet: "holdout",
  }));

  writeFileSync(
    "tests/fixtures/materiality-claims-corpus.json",
    JSON.stringify(corpus, null, 2) + "\n",
  );
  const byAction = new Map<string, number>();
  for (const c of corpus)
    byAction.set(c.predicate, (byAction.get(c.predicate) ?? 0) + 1);
  console.log(
    `wrote ${corpus.length} claims → tests/fixtures/materiality-claims-corpus.json`,
  );
  console.log([...byAction.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
