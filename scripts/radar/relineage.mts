/* R6.1b relineage runner — reconciles document lineage on changed
 * events via lib/db/relineage.ts (unknown/unclassified AND 'original'
 * re-evaluation against the current union pool: a late-arriving older
 * doc can prove an 'original' was actually derived).
 *
 *   DATABASE_URL=... npx tsx scripts/radar/relineage.mts [--since ISO] [--limit N] [--dry]
 *
 *   --since defaults to the last committed job_runs cursor, else 7d.
 * Incremental + observable via job_runs; cursor only covers the
 * contiguous successful prefix — failed events are retried next run. */
import { getPool } from "../../lib/db/pool.ts";
import { relineageEvents } from "../../lib/db/relineage.ts";
import {
  checkpointCursor,
  finishJob,
  lastDoneCursor,
  startJob,
  updateJob,
} from "../../lib/db/jobs.ts";

const DEFAULT_WINDOW_H = 24 * 7; // first run: last week of changed events

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 400;
const sinceIdx = args.indexOf("--since");
const DRY = args.includes("--dry");

const db = getPool();
const run = DRY ? null : await startJob("relineage", { limit: LIMIT });
const since: string =
  sinceIdx >= 0
    ? args[sinceIdx + 1]
    : ((await lastDoneCursor("relineage")) ??
      new Date(Date.now() - DEFAULT_WINDOW_H * 3600_000).toISOString());
console.log(`relineage: events changed since ${since}${DRY ? " (dry)" : ""}`);

const { rows: events } = await db.query<{
  id: string;
  last_seen_at: string;
}>(
  `SELECT e.id, e.last_seen_at FROM events e
    WHERE e.status NOT IN ('merged','archived') AND e.last_seen_at > $1
    ORDER BY e.last_seen_at ASC LIMIT $2`,
  [since, LIMIT],
);
if (!events.length) {
  console.log("relineage: no changed events");
  if (run) await finishJob(run.id, { processed: 0, cursorTs: since });
  await db.end();
  process.exit(0);
}

const res = await relineageEvents(
  events.map((e) => e.id),
  { dryRun: DRY },
);
const failedIds = new Set(res.failedEventIds);
const cursor = checkpointCursor(
  events.map((r) => ({ id: r.id, lastSeenAt: r.last_seen_at })),
  failedIds,
  since,
);
if (run)
  await updateJob(run.id, {
    processed: events.length - failedIds.size,
    failed: failedIds.size,
    cursorTs: cursor,
  });

console.log(
  `relineage: ${events.length - failedIds.size} events, ${res.minted} lineage versions minted, ${res.resolved} resolved, ${failedIds.size} failed → ${new Set(res.changedEventIds).size} events dirtied for adjudication${DRY ? " (dry)" : ""}`,
);
if (run)
  await finishJob(run.id, {
    processed: events.length - failedIds.size,
    failed: failedIds.size,
    cursorTs: cursor,
  });
await db.end();
