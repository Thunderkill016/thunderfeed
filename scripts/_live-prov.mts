import pg from "pg";
const PROD = `postgresql://postgres.vwpudirxzaxhbczknaan:${process.env.SUPABASE_DB_PASS}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const db = new pg.Pool({ connectionString: PROD, ssl: { rejectUnauthorized: false } });
const q = async (s: string) => (await db.query(s)).rows;
const RUN_START = "2026-09-29 09:04:33+00";
console.log("== coverage:", (await q(`SELECT count(*) total,
  count(*) FILTER (WHERE p.id IS NOT NULL) with_prov
FROM event_evidence ee
LEFT JOIN event_attachment_provenance p
  ON p.event_id = ee.event_id AND p.evidence_version_id = ee.evidence_version_id
WHERE ee.attached_at > '${RUN_START}'`))[0]);
console.log("== orphan FK (should be 0):", (await q(`SELECT count(*) c FROM event_attachment_provenance p LEFT JOIN resolver_decisions rd ON rd.id = p.resolver_decision_id WHERE rd.id IS NULL`))[0]);
console.log("== missing path/explanation:", (await q(`SELECT count(*) c FROM event_attachment_provenance WHERE path IS NULL OR explanation IS NULL OR explanation = '{}'`))[0]);
console.log("== path distribution:", await q(`SELECT decision, path, count(*) c FROM event_attachment_provenance GROUP BY 1,2 ORDER BY c DESC`));
console.log("== entity-set columns populated:", (await q(`SELECT count(*) total,
  count(incoming_entities) inc, count(incoming_core_entities) inc_core,
  count(candidate_entities_before) cand, count(candidate_core_entities_before) cand_core
FROM event_attachment_provenance`))[0]);
await db.end();
