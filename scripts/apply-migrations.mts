/* Apply pending migrations to a target DB, tracked in a ledger table.
 *
 *   npx tsx scripts/apply-migrations.mts <url>                 # all pending, sorted by name
 *   npx tsx scripts/apply-migrations.mts <url> --status        # applied/pending list
 *   npx tsx scripts/apply-migrations.mts <url> <file...>       # explicit files only
 *   npx tsx scripts/apply-migrations.mts <url> --mark <name...># record as applied without running
 *                                                             #   (baseline an existing DB)
 *
 * Each file runs verbatim (files carry their own BEGIN/COMMIT where
 * needed; files without BEGIN are wrapped in one transaction). Applied
 * names land in schema_migrations so re-runs are idempotent and a
 * failed file surfaces instead of silently half-applying. */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import pg from "pg";
import { pgSsl } from "../lib/db/supabaseCa";

const MIGRATIONS_DIR = "db/migrations";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  throw new Error(
    "usage: apply-migrations <url> [--status|--mark <name...>|<file...>]",
  );
}
const statusMode = args[0] === "--status";
const markMode = args[0] === "--mark";
const markNames = markMode ? args.slice(1) : [];
const explicit = statusMode || markMode ? [] : args;

const allFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const files = explicit.length ? explicit.map((f) => basename(f)) : allFiles;

const c = new pg.Client({ connectionString: url, ssl: pgSsl(url) });
await c.connect();
await c.query("SET SESSION default_transaction_read_only=off").catch(() => {});
await c.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name       text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
);

const { rows: applied } = await c.query<{ name: string }>(
  `SELECT name FROM schema_migrations`,
);
const appliedSet = new Set(applied.map((r) => r.name));

if (statusMode) {
  for (const f of allFiles) {
    console.log(`${appliedSet.has(f) ? "applied" : "PENDING"} ${f}`);
  }
  await c.end();
  process.exit(0);
}

if (markMode) {
  for (const n of markNames) {
    await c.query(
      `INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [n],
    );
    console.log(`marked ${n}`);
  }
  await c.end();
  process.exit(0);
}

for (const f of files) {
  if (appliedSet.has(f)) {
    console.log(`skip    ${f} (already applied)`);
    continue;
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
  const hasTxn = /^\s*BEGIN\b/im.test(sql);
  if (!hasTxn) await c.query("BEGIN");
  try {
    await c.query(sql);
    await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
    if (!hasTxn) await c.query("COMMIT");
    console.log(`applied ${f}`);
  } catch (e) {
    if (!hasTxn) await c.query("ROLLBACK").catch(() => {});
    console.error(`FAILED  ${f}: ${(e as Error).message}`);
    process.exitCode = 1;
    break; // stop — later migrations may depend on this one
  }
}
await c.end();
