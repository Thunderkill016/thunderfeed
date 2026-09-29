import pg from "pg";
const PROD = `postgresql://postgres.vwpudirxzaxhbczknaan:${process.env.SUPABASE_DB_PASS}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const db = new pg.Pool({ connectionString: PROD, ssl: { rejectUnauthorized: false } });
const q = async (s: string) => (await db.query(s)).rows;
// Split at the code boundary: first row with entity sets populated = new code
const b = await q(`SELECT min(created_at) boundary FROM event_attachment_provenance WHERE incoming_entities IS NOT NULL`);
console.log("new-code boundary:", b[0].boundary);
console.log("OLD-CODE rows (pre-boundary):", (await q(`SELECT count(*) c FROM event_attachment_provenance WHERE created_at < '${b[0].boundary.toISOString()}'`))[0]);
console.log("NEW-CODE rows:", (await q(`SELECT count(*) c,
  count(incoming_entities) inc, count(candidate_entities_before) cand,
  count(*) FILTER (WHERE decision='create') creates,
  count(*) FILTER (WHERE decision='merge') merges
FROM event_attachment_provenance WHERE created_at >= '${b[0].boundary.toISOString()}'`))[0]);
// new attachments under new code: coverage
console.log("NEW-CODE attachment coverage:", (await q(`SELECT count(*) total,
  count(*) FILTER (WHERE p.id IS NOT NULL) with_prov,
  count(*) FILTER (WHERE p.incoming_entities IS NOT NULL) with_inc_set
FROM event_evidence ee
JOIN event_attachment_provenance p
  ON p.event_id = ee.event_id AND p.evidence_version_id = ee.evidence_version_id
WHERE p.created_at >= '${b[0].boundary.toISOString()}'`))[0]);
// creates should have candidate_* = NULL (no candidate), merges should have it
console.log("new-code creates missing incoming set (should be 0):", (await q(`SELECT count(*) c FROM event_attachment_provenance WHERE created_at >= '${b[0].boundary.toISOString()}' AND decision='create' AND incoming_entities IS NULL`))[0]);
console.log("new-code merges missing candidate set (should be 0):", (await q(`SELECT count(*) c FROM event_attachment_provenance WHERE created_at >= '${b[0].boundary.toISOString()}' AND decision='merge' AND candidate_entities_before IS NULL`))[0]);
await db.end();
