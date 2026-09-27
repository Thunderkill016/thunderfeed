/* R6.1 adjudication runner — recomputes claim truth on changed events
 * via the shared position engine (lib/db/adjudicate.ts → positions.ts).
 *
 *   DATABASE_URL=... npx tsx scripts/radar/adjudicate.mts [--since ISO] [--events N] [--dry]
 *
 * Scope: events changed since the last successful run (or --since, or
 * the last --events). State changes are append-only claim_versions
 * mints; 'confirmed' is never minted by batch (authority = ingest act).
 * Every run is recorded in job_runs. */
import { getPool } from "../../lib/db/pool.ts";
import { adjudicateEvents } from "../../lib/db/adjudicate.ts";
import { finishJob, lastDoneCursor, startJob } from "../../lib/db/jobs.ts";

const args = process.argv.slice(2);
const evIdx = args.indexOf("--events");
const EVENTS = evIdx >= 0 ? Number(args[evIdx + 1]) : 30;
const sinceIdx = args.indexOf("--since");
const DRY = args.includes("--dry");
const DEFAULT_WINDOW_H = 48;

const db = getPool();
const run = DRY ? null : await startJob("adjudicate", { events: EVENTS });
const since: string =
  sinceIdx >= 0
    ? args[sinceIdx + 1]
    : ((await lastDoneCursor("adjudicate")) ??
      new Date(Date.now() - DEFAULT_WINDOW_H * 3600_000).toISOString());

const { rows } = await db.query<{ id: string; title: string }>(
  `SELECT e.id, ev.title
     FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
    WHERE e.status NOT IN ('merged','archived') AND e.last_seen_at > $1
    ORDER BY e.last_seen_at ASC
    LIMIT $2`,
  [since, EVENTS * 10],
);
console.log(
  `adjudicate: ${rows.length} changed events since ${since}${DRY ? " (dry)" : ""}`,
);

const decisions = await adjudicateEvents(
  rows.map((r) => r.id),
  { dryRun: DRY },
);
const byEvent = new Map<string, typeof decisions>();
for (const d of decisions) {
  if (!byEvent.has(d.eventId)) byEvent.set(d.eventId, []);
  byEvent.get(d.eventId)!.push(d);
}
for (const e of rows) {
  const ds = byEvent.get(e.id) ?? [];
  if (!ds.length) continue;
  console.log(`\n${e.title}`);
  for (const d of ds) console.log(`  ${d.from} → ${d.to}  (${d.reason})`);
}
const tally = new Map<string, number>();
for (const d of decisions) tally.set(d.to, (tally.get(d.to) ?? 0) + 1);
console.log(
  `\ntotal: ${decisions.length} claims moved — ` +
    [...tally].map(([k, v]) => `${k}:${v}`).join(" "),
);
/* cursor = watermark = the newest last_seen_at we actually processed —
 * next run only looks at events changed after it */
const cursor = rows.length
  ? (
      await db.query<{ m: string }>(
        `SELECT max(last_seen_at) m FROM events WHERE id = ANY($1)`,
        [rows.map((r) => r.id)],
      )
    ).rows[0].m
  : since;
if (run) await finishJob(run.id, { processed: rows.length, cursorTs: cursor });
await db.end();
