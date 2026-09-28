/* R7.1c — drain the claim-materiality queue.
 *
 *   DATABASE_URL=… npx tsx scripts/materiality/drain-claims.mts
 *
 * Queue-driven only (no timestamp cursor): pending dirty_claims →
 * canonical input → deterministic score → generation-safe publish →
 * generation-bound ack — all inside lib/db/claim-materiality.ts. */
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

import { drainClaimMateriality } from "../../lib/db/claim-materiality.ts";
import { getPool } from "../../lib/db/pool.ts";

const r = await drainClaimMateriality({ metadata: { trigger: "cli" } });
console.log(
  `processed=${r.processed} inserted=${r.assessmentsInserted} ` +
    `reused=${r.assessmentsReused} projected=${r.projectionUpdated} ` +
    `stale=${r.staleGeneration} failed=${r.failed} ` +
    `pending=${r.pendingRemaining} run=${r.runId}`,
);
await getPool().end();
