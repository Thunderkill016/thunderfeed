/* R7.1b — freeze a CLAIM-level corpus for the claim-materiality lab.
 *
 * Unit = logical claim (claims.current_version_id snapshot), not events.
 * Stratified: every economic-predicate claim we have (capped), plus a
 * deterministic md5-ordered slice of non-economic predicates for
 * negative space — a given DB snapshot always dumps the same claim IDs.
 *
 * The scorer input is built by the SHARED canonical builder
 * (lib/db/claim-materiality.ts loadClaimMaterialityInputs) — the same
 * function the production materiality worker calls, so a benchmarked
 * input is byte-identical to a production-scored one.
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
import { loadClaimMaterialityInputs } from "../../lib/db/claim-materiality.ts";

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

/* ── dump ───────────────────────────────────────────────────── */

async function main() {
  const db = getPool();

  // deterministic selection only — corpus identity is the ordered
  // claim-id list, never wall-clock randomness
  const { rows: picked } = await db.query<{ claim_id: string }>(
    `WITH picked AS (
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
     SELECT id AS claim_id FROM chosen ORDER BY 1`,
    [ECONOMIC_PREDICATES, CAP_PER_PREDICATE, NEGATIVE_SAMPLE],
  );
  const claimIds = picked.map((r) => r.claim_id);

  /* canonical inputs — identical to what drainClaimMateriality scores */
  const rows = await loadClaimMaterialityInputs(claimIds);

  const items = claimIds.map((id) => {
    const r = rows.get(id);
    if (!r) throw new Error(`canonical builder missed claim ${id}`);
    return { ...r.input, eventId: r.eventId, sourceSet: "holdout" };
  });

  const idsHash = createHash("sha256")
    .update(claimIds.join("\n"))
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
