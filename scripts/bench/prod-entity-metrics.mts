import { Client } from "pg";
const client = new Client({
  host: "aws-0-ap-southeast-1.pooler.supabase.com",
  port: 6543,
  database: "postgres",
  user: "postgres.vwpudirxzaxhbczknaan",
  password: process.env.SUPABASE_DB_PASS,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const q = async (s: string) => (await client.query(s)).rows;
console.log(
  "entities:",
  await q(
    `SELECT count(*)::int n, count(*) FILTER (WHERE status='unresolved')::int unresolved FROM entities`,
  ),
);
console.log(
  "by type:",
  await q(
    `SELECT entity_type, count(*)::int n FROM entities GROUP BY 1 ORDER BY 2 DESC`,
  ),
);
console.log("aliases:", await q(`SELECT count(*)::int n FROM entity_aliases`));
console.log(
  "identifiers:",
  await q(`SELECT scheme, count(*)::int n FROM entity_identifiers GROUP BY 1`),
);
console.log(
  "relationships:",
  await q(`SELECT count(*)::int n FROM entity_relationships`),
);
console.log(
  "junction:",
  await q(
    `SELECT count(*)::int n, count(entity_id)::int with_id FROM event_entities`,
  ),
);
console.log(
  "unmapped junction:",
  await q(
    `SELECT ee.entity_slug, count(*)::int n FROM event_entities ee WHERE ee.entity_id IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  ),
);
await client.end();
