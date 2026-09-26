/* Apply pending migrations to a target DB.
 *   npx tsx scripts/apply-migrations.mts <url> <file...>
 * Files run verbatim (no PG-ONLY stripping — production Postgres). */
import { readFileSync } from "node:fs";
import pg from "pg";

const [url, ...files] = process.argv.slice(2);
if (!url || !files.length)
  throw new Error("usage: apply-migrations <url> <file...>");
const c = new pg.Client({ connectionString: url });
await c.connect();
for (const f of files) {
  const sql = readFileSync(f, "utf8");
  await c.query(sql);
  console.log(`applied ${f}`);
}
await c.end();
