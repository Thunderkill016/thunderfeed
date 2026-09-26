/* Preflight for migration 0026 — inspects prod state before applying.
 * npx tsx scripts/market/preflight-0026.mts */
import { readFileSync } from "node:fs";
import { connectDb } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const dbUrl = process.env.DATABASE_URL?.includes("supabase")
  ? process.env.DATABASE_URL
  : `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(
      process.env.SUPABASE_DB_PASS ?? "",
    )}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const c = connectDb(dbUrl);
await c.connect();

const def = await c.query(
  `SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
    WHERE conrelid='market_series'::regclass AND contype='c'
    ORDER BY conname`,
);
console.log("market_series CHECKs:", JSON.stringify(def.rows, null, 2));

for (const t of [
  "corporate_actions",
  "corporate_action_versions",
  "corporate_action_assertions",
  "corporate_action_derivations",
]) {
  const r = (await c
    .query(`SELECT count(*) n FROM ${t}`)
    .catch((e) => ({ absent: e.message.slice(0, 60) }))) as
    { rows: { n: string }[] } | { absent: string };
  console.log(t, ":", JSON.stringify("rows" in r ? r.rows[0] : r));
}

const fn = await c.query(
  `SELECT proname FROM pg_proc
    WHERE proname IN ('uuid_v7','reject_history_mutation')`,
);
console.log("helper functions:", JSON.stringify(fn.rows));

const roles = await c.query(
  `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')`,
);
console.log("supabase roles present:", JSON.stringify(roles.rows));
await c.end();
