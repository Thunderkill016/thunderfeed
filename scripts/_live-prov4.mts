import pg from "pg";
const PROD = `postgresql://postgres.vwpudirxzaxhbczknaan:${process.env.SUPABASE_DB_PASS}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const db = new pg.Pool({ connectionString: PROD, ssl: { rejectUnauthorized: false } });
const rows = (await db.query(`SELECT p.path, p.candidate_event_id, p.candidate_signature_hash_before,
  p.candidate_entity_count_before, p.score, p.incoming_entities,
  rd.decision rd_decision, rd.path rd_path, rd.reasons
FROM event_attachment_provenance p
JOIN resolver_decisions rd ON rd.id = p.resolver_decision_id
WHERE p.created_at >= '2026-09-29 09:48:07+00' AND p.decision='merge' AND p.candidate_entities_before IS NULL`)).rows;
console.log(JSON.stringify(rows, null, 2));
await db.end();
