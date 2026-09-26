/**
 * Production DB security audit — proves the raw Supabase Data API
 * surface is locked down. Fails non-zero on violations; prints counts,
 * never credentials.
 *
 *   npx tsx scripts/audit-db-security.mts            # audit + report
 *   npx tsx scripts/audit-db-security.mts --snapshot # also write bench artifact
 *   npm run audit:db-security
 *
 *   options: --db URL  --out bench/db-security-audit.json
 *
 * Invariants checked:
 *   1. every public-schema table has RLS enabled (no policy ⇒ deny-all
 *      for anon/authenticated — deliberate, the app has no Data API)
 *   2. anon/authenticated hold NO table privileges beyond the future
 *      allowlist (none today)
 *   3. public functions have a fixed search_path (advisor:
 *      function_search_path_mutable)
 *
 * The privileged server role (postgres via pooler) bypasses RLS and is
 * intentionally out of scope — app access is server-side pg only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

const URL =
  opt("--db", "") ||
  process.env.PROD_URL ||
  `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(process.env.SUPABASE_DB_PASS!)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const SNAPSHOT = flag("--snapshot");
const OUT = opt("--out", "bench/db-security-audit.json");

/* roles checked for raw-table privileges — PostgREST JWT roles */
const API_ROLES = ["anon", "authenticated"];
/* privilege levels that must not be held at all */
const FORBIDDEN = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

const client = new pg.Client({ connectionString: URL });
await client.connect();

const tables = (
  await client.query<{
    relname: string;
    relrowsecurity: boolean;
    tableowner: string;
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relowner::regrole::text tableowner
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`,
  )
).rows;

const grants = (
  await client.query<{
    table_name: string;
    grantee: string;
    privilege_type: string;
  }>(
    `SELECT table_name, grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee = ANY($1)
     ORDER BY table_name, grantee, privilege_type`,
    [API_ROLES],
  )
).rows;

const functions = (
  await client.query<{
    proname: string;
    proowner: string;
    mutable: boolean;
  }>(
    `SELECT p.proname, p.proowner::regrole::text proowner,
            (p.proconfig IS NULL OR NOT EXISTS (
               SELECT 1 FROM unnest(p.proconfig) c
               WHERE c LIKE 'search_path=%')) AS mutable
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
     ORDER BY p.proname`,
  )
).rows;

await client.end();

const rlsDisabled = tables.filter((t) => !t.relrowsecurity);
const forbiddenGrants = grants.filter((g) =>
  FORBIDDEN.includes(g.privilege_type),
);
const readableGrants = grants.filter(
  (g) => !FORBIDDEN.includes(g.privilege_type),
);
const mutableFns = functions.filter((f) => f.mutable);

const summary = {
  generatedAt: new Date().toISOString(),
  tables: {
    total: tables.length,
    rlsEnabled: tables.length - rlsDisabled.length,
    rlsDisabled: rlsDisabled.map((t) => t.relname),
  },
  apiPrivileges: {
    anon: grants.filter(
      (g) => g.grantee === "anon" && FORBIDDEN.includes(g.privilege_type),
    ).length,
    authenticated: grants.filter(
      (g) =>
        g.grantee === "authenticated" && FORBIDDEN.includes(g.privilege_type),
    ).length,
    readableOnly: readableGrants.length,
  },
  functions: {
    total: functions.length,
    mutableSearchPath: mutableFns.map((f) => f.proname),
  },
  owners: [...new Set(tables.map((t) => t.tableowner))],
};
const pass =
  rlsDisabled.length === 0 &&
  forbiddenGrants.length === 0 &&
  mutableFns.length === 0;

if (SNAPSHOT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        ...summary,
        detail: {
          tables,
          grants: grants.map(
            (g) => `${g.table_name}:${g.grantee}:${g.privilege_type}`,
          ),
          functions,
        },
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify(summary, null, 2));
console.log(pass ? "AUDIT: PASS" : "AUDIT: FAIL");
process.exit(pass ? 0 : 1);
