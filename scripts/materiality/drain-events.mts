/* R7.1d.2 — drain the event-materiality queue. SHADOW ONLY — nothing
 * user-facing may consume event_materiality_current yet.
 *
 *   DATABASE_URL=… npx tsx scripts/materiality/drain-events.mts
 *
 * Queue-driven only (no timestamp cursor): pending
 * dirty_events(job='event_materiality') → canonical input →
 * aggregateClaimsToEvent → set-CAS + generation-bound publish — all
 * inside lib/db/event-materiality.ts. Must run AFTER the claim drain:
 * the claim drain is this queue's producer. */
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

import { drainEventMateriality } from "../../lib/db/event-materiality.ts";
import { getPool } from "../../lib/db/pool.ts";

const r = await drainEventMateriality({ metadata: { trigger: "cli" } });
console.log(
  `processed=${r.processed} inserted=${r.assessmentsInserted} ` +
    `reused=${r.assessmentsReused} projected=${r.projectionUpdated} ` +
    `stale=${r.staleGeneration} failed=${r.failed} ` +
    `pending=${r.pendingRemaining} run=${r.runId}`,
);
await getPool().end();
/* fail-closed: a durable queue means a nonzero exit never loses work —
 * the next run retries — but a green workflow with failed/pending rows
 * would mask stale projections */
if (r.failed > 0 || r.pendingRemaining > 0) process.exitCode = 1;
