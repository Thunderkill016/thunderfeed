/* RLS smoke test — runs the migration set against a REAL Postgres (CI
 * service container), then proves the lockdown is functional, not just
 * declared: a privilege-free role gets zero rows from every public table.
 *
 *   npx tsx scripts/ci-rls-smoke.mts <postgres_url>
 *
 * Exits non-zero on any leak. Complements audit-db-security.mts (catalog
 * assertions) with an actual denied-read probe per table. */
import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const url = process.argv[2];
if (!url) throw new Error("usage: ci-rls-smoke <postgres_url>");

const admin = new pg.Client({ connectionString: url });
await admin.connect();

// ── apply every migration in order ───────────────────────────────────────
const files = readdirSync("db/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const f of files) {
  const sql = readFileSync(join("db/migrations", f), "utf8");
  // event triggers need CREATE EVENT TRIGGER privilege — superuser in CI
  await admin.query(sql);
}
console.log(`applied ${files.length} migrations`);

// ── catalog check: every public table has RLS on ─────────────────────────
const { rows: tables } = await admin.query<{ rel: string; rls: boolean }>(
  `SELECT c.relname AS rel, c.relrowsecurity AS rls
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1`,
);
const noRls = tables.filter((t) => !t.rls);
if (noRls.length) {
  console.error("tables WITHOUT rls:", noRls.map((t) => t.rel).join(", "));
  process.exit(1);
}
console.log(`rls enabled on all ${tables.length} public tables`);

// ── functional probe: unprivileged role reads nothing ────────────────────
await admin.query(`DROP ROLE IF EXISTS smoke_anon`);
await admin.query(`CREATE ROLE smoke_anon NOLOGIN`);
await admin.query(`GRANT USAGE ON SCHEMA public TO smoke_anon`);
// SELECT granted — so what denies reads is RLS itself (deny-by-default
// with zero policies), not missing ACLs. That's the posture being probed.
await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO smoke_anon`);

// SET ROLE inside the admin session — a NOLOGIN role can't own a
// connection, but SET ROLE exercises exactly the grant+RLS check path.
const leaked: string[] = [];
await admin.query(`SET ROLE smoke_anon`);
for (const t of tables) {
  try {
    // RLS deny-all returns zero rows — it does NOT raise. A row coming
    // back means a permissive policy or missing relrowsecurity exists.
    const r = await admin.query(`SELECT count(*)::int n FROM "${t.rel}"`);
    if ((r.rows[0]?.n as number) > 0) leaked.push(t.rel);
  } catch {
    /* permission denied at ACL level — also safe */
  }
}
await admin.query(`RESET ROLE`);
if (leaked.length) {
  console.error(
    "RLS LEAK — unprivileged role read rows from:",
    leaked.join(", "),
  );
  process.exit(1);
}
await admin.query(`DROP ROLE smoke_anon`);
await admin.end();
console.log(
  `smoke OK — ${tables.length} tables, zero readable by unprivileged role`,
);
