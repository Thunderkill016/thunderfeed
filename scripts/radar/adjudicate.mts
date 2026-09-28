/* R6.1b adjudication runner — recomputes claim truth on changed events
 * via the shared position engine (lib/db/adjudicate.ts → positions.ts).
 *
 *   DATABASE_URL=... npx tsx scripts/radar/adjudicate.mts [--since ISO] [--events N] [--dry]
 *
 * Scope: events changed since the last committed cursor (or --since, or
 * a default window). Mutable states (reported/supported/disputed) are
 * recomputed against the current evidence graph; the minted state is
 * path-invariant — batch may mint 'confirmed' when direct primary
 * evidence is discovered retroactively. Per-event failure granularity:
 * a failed event never advances the watermark and is retried next run.
 * Every run is recorded in job_runs. */
import { getPool } from "../../lib/db/pool.ts";
import { adjudicateEvents } from "../../lib/db/adjudicate.ts";
import {
  checkpointCursor,
  finishJob,
  lastDoneCursor,
  markDirtyDone,
  pendingDirtyEvents,
  startJob,
  updateJob,
} from "../../lib/db/jobs.ts";

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

const { rows } = await db.query<{ id: string; title: string; ts: string }>(
  `SELECT e.id, ev.title, e.last_seen_at AS ts
     FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
    WHERE e.status NOT IN ('merged','archived') AND e.last_seen_at > $1
    ORDER BY e.last_seen_at ASC
    LIMIT $2`,
  [since, EVENTS * 10],
);
console.log(
  `adjudicate: ${rows.length} changed events since ${since}${DRY ? " (dry)" : ""}`,
);

/* per-event adjudication — one event's bad data can never block or
 * misattribute another's truth transition */
const failedIds = new Set<string>();
const tally = new Map<string, number>();
let minted = 0;
let superseded = 0;
for (const e of rows) {
  try {
    const res = await adjudicateEvents([e.id], { dryRun: DRY });
    superseded += res.superseded;
    for (const d of DRY ? res.decisions : res.landed) {
      console.log(`${e.title}\n  ${d.from} → ${d.to}  (${d.reason})`);
      tally.set(d.to, (tally.get(d.to) ?? 0) + 1);
      minted++;
    }
  } catch (err) {
    failedIds.add(e.id);
    console.error(`event ${e.id} failed:`, (err as Error).message);
  }
  if (run && (failedIds.size + minted) % 50 === 0) {
    await updateJob(run.id, {
      processed: rows.indexOf(e) + 1,
      failed: failedIds.size,
      cursorTs: checkpointCursor(
        rows.map((r) => ({ id: r.id, lastSeenAt: r.ts })),
        failedIds,
        since,
      ),
    });
  }
}

/* durable queue drain — events dirtied by producers (relineage etc.)
 * whose last_seen_at is BEHIND the cursor. Timestamp discovery alone
 * can never see them; the queue is the only correct hand-off. A dirty
 * event is acknowledged only after its adjudication commits. */
const dirty = await pendingDirtyEvents("adjudicate");
let dirtyDone = 0;
for (const w of dirty) {
  /* already adjudicated by this run's sweep — ack it so the queue
   * drains instead of re-processing forever (only on success, and
   * only for the generation we read: a re-enqueue mid-run survives) */
  if (rows.some((r) => r.id === w.eventId)) {
    if (!DRY && !failedIds.has(w.eventId)) {
      await markDirtyDone(w.eventId, "adjudicate", w.generation);
      dirtyDone++;
    }
    continue;
  }
  try {
    const res = await adjudicateEvents([w.eventId], { dryRun: DRY });
    superseded += res.superseded;
    for (const d of DRY ? res.decisions : res.landed) {
      console.log(`  [dirty] ${d.from} → ${d.to}  (${d.reason})`);
      tally.set(d.to, (tally.get(d.to) ?? 0) + 1);
      minted++;
    }
    /* ack binds the generation read BEFORE work started — if a producer
     * re-dirtied the event mid-flight, this updates 0 rows and the
     * newer unit stays pending instead of being silently eaten */
    if (!DRY) await markDirtyDone(w.eventId, "adjudicate", w.generation);
    dirtyDone++;
  } catch (err) {
    console.error(`dirty event ${w.eventId} failed:`, (err as Error).message);
    /* left pending — retried next run; does not move the time cursor */
  }
}
if (dirty.length)
  console.log(`dirty queue: ${dirty.length} pending, ${dirtyDone} adjudicated`);

console.log(
  `\ntotal: ${minted} claims moved — ` +
    [...tally].map(([k, v]) => `${k}:${v}`).join(" ") +
    ` | failed events: ${failedIds.size}` +
    (superseded ? ` | superseded mints: ${superseded}` : ""),
);
/* cursor only covers the contiguous successful prefix — a failed event
 * is never jumped over; next run retries exactly it */
const cursor = checkpointCursor(
  rows.map((r) => ({ id: r.id, lastSeenAt: r.ts })),
  failedIds,
  since,
);
if (run)
  await finishJob(run.id, {
    processed: rows.length - failedIds.size,
    failed: failedIds.size,
    cursorTs: cursor,
  });
await db.end();
