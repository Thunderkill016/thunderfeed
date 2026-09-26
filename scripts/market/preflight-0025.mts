/* Preflight for migration 0025 — inspects prod state before applying.
 * npx tsx scripts/market/preflight-0025.mts */
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
    WHERE conrelid = 'reference_observations'::regclass
      AND contype='c' AND conname LIKE '%provider%'`,
);
console.log("provider CHECK:", JSON.stringify(def.rows, null, 2));

const obs = await c.query(
  `SELECT provider, dataset, count(*) n FROM reference_observations
    GROUP BY provider, dataset ORDER BY provider, dataset`,
);
console.log("observations:", JSON.stringify(obs.rows));

const mk = await c.query(
  `SELECT (SELECT count(*) FROM market_series) s,
          (SELECT count(*) FROM market_points) p,
          (SELECT count(*) FROM market_point_versions) v`,
);
console.log("market state:", JSON.stringify(mk.rows[0]));

const cred = {
  ALPHAVANTAGE_API_KEY: process.env.ALPHAVANTAGE_API_KEY ? "PRESENT" : "ABSENT",
  TIINGO_API_TOKEN: process.env.TIINGO_API_TOKEN ? "PRESENT" : "ABSENT",
};
console.log("credentials:", JSON.stringify(cred));
await c.end();
