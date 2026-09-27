/* Signal outcome resolver — the accountability half of market_move deltas.
 *
 *   npx tsx scripts/market/resolve-outcomes.mts
 *
 * Every market_move delta mints 3 pending signal_outcomes (T+1/T+5/T+20
 * sessions of the same series). This job resolves them once the horizon
 * session exists; stale pendings go 'expired', never silently dropped.
 * Logic lives in lib/db/market.ts → resolveSignalOutcomes (pg-mem tested).
 */
import { readFileSync } from "node:fs";
import { resolveSignalOutcomes } from "../../lib/db/market.ts";
import { connectDb } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const c = connectDb();
await c.connect();
const r = await resolveSignalOutcomes(c);
console.log(
  `resolved ${r.resolved}, expired ${r.expired}, still pending ${r.stillPending}, errors ${r.errors.length}`,
);
for (const e of r.errors) console.log(`  ! ${e}`);
await c.end();
process.exit(r.errors.length ? 1 : 0);
