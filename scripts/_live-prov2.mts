import pg from "pg";
const PROD = `postgresql://postgres.vwpudirxzaxhbczknaan:${process.env.SUPABASE_DB_PASS}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const db = new pg.Pool({ connectionString: PROD, ssl: { rejectUnauthorized: false } });
const q = async (s: string) => (await db.query(s)).rows;
console.log("== rows per hour-bucket with entity-set fill:", await q(`SELECT date_trunc('minute', created_at) m,
  count(*) c, count(incoming_entities) inc, count(candidate_entities_before) cand,
  count(*) FILTER (WHERE decision='create') creates, count(*) FILTER (WHERE decision='merge') merges
FROM event_attachment_provenance GROUP BY 1 ORDER BY 1`));
await db.end();
