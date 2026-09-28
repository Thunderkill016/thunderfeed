/* R6.1 enrichment — entity prominence projection only.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/enrich.mts [--since ISO] [--limit N] [--dry]
 *
 * What it does NOT do anymore: title-shingle independence writes. That
 * was the R6 mistake — a document's cluster inside one event is not a
 * document-global property. Canonical independence = evidence_lineage
 * effective roots (see lib/db/read.ts getEventEvidenceStats).
 *
 * For every CHANGED event (last_seen_at > cursor, or --since):
 *   score each event_entities row (title hit / doc-title share / claim
 *   subject) and write role + prominence + prominence_method +
 *   prominence_evidence — a derived assessment WITH provenance.
 *
 * Incremental + observable via job_runs; per-event writes so a crash
 * mid-run leaves a resumable cursor, never a half-committed batch. */
import { getPool } from "../../lib/db/pool.ts";
import { prominenceFor } from "../../lib/enrich.ts";
import {
  checkpointCursor,
  finishJob,
  lastDoneCursor,
  startJob,
  updateJob,
} from "../../lib/db/jobs.ts";

const METHOD = "title-share-v1";
const DEFAULT_WINDOW_H = 48; // first run: last 48h of changed events

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 500;
const sinceIdx = args.indexOf("--since");
const DRY = args.includes("--dry");

const db = getPool();
const run = DRY ? null : await startJob("enrich", { limit: LIMIT });
const since: string =
  sinceIdx >= 0
    ? args[sinceIdx + 1]
    : ((await lastDoneCursor("enrich")) ??
      new Date(Date.now() - DEFAULT_WINDOW_H * 3600_000).toISOString());
console.log(`enrich: changed events since ${since}${DRY ? " (dry)" : ""}`);

const { rows: events } = await db.query<{
  id: string;
  title: string;
  last_seen_at: string;
}>(
  `SELECT e.id, ev.title, e.last_seen_at
   FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
   WHERE e.status NOT IN ('merged','archived') AND e.last_seen_at > $1
   ORDER BY e.last_seen_at ASC
   LIMIT $2`,
  [since, LIMIT],
);
console.log(`enrich: ${events.length} changed events`);
if (events.length === 0) {
  if (run) await finishJob(run.id, { processed: 0, cursorTs: since });
  await db.end();
  process.exit(0);
}
const ids = events.map((e) => e.id);

const { rows: docs } = await db.query<{
  event_id: string;
  title: string;
}>(
  `SELECT ee.event_id, COALESCE(ev.title, '') AS title
   FROM event_evidence ee
   JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
   WHERE ee.event_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
  ids,
);

const { rows: entRows } = await db.query<{
  event_id: string;
  entity_slug: string;
}>(
  `SELECT event_id, entity_slug FROM event_entities
   WHERE event_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
  ids,
);

const { rows: claimSubs } = await db.query<{
  event_id: string;
  canonical_key: string;
}>(
  `SELECT DISTINCT c.event_id, en.canonical_key
   FROM claims c JOIN entities en ON en.id = c.subject_entity_id
   WHERE c.event_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
  ids,
);
const subjectsByEvent = new Map<string, Set<string>>();
for (const r of claimSubs) {
  if (!subjectsByEvent.has(r.event_id))
    subjectsByEvent.set(r.event_id, new Set());
  subjectsByEvent.get(r.event_id)!.add(r.canonical_key);
}

const docTitlesByEvent = new Map<string, string[]>();
for (const d of docs) {
  if (!d.title) continue;
  if (!docTitlesByEvent.has(d.event_id)) docTitlesByEvent.set(d.event_id, []);
  docTitlesByEvent.get(d.event_id)!.push(d.title);
}
const entsByEvent = new Map<string, string[]>();
for (const r of entRows) {
  if (!entsByEvent.has(r.event_id)) entsByEvent.set(r.event_id, []);
  entsByEvent.get(r.event_id)!.push(r.entity_slug);
}

let processed = 0;
let entUpdates = 0;
const failedIds = new Set<string>();

for (const e of events) {
  const docTitles = docTitlesByEvent.get(e.id) ?? [];
  const subjects = subjectsByEvent.get(e.id) ?? new Set<string>();
  const ents = entsByEvent.get(e.id) ?? [];
  const writes = ents.map((slug) => {
    const p = prominenceFor({
      slug,
      eventTitle: e.title,
      docTitles,
      claimSubjectKeys: subjects,
    });
    return { slug, ...p };
  });
  if (!DRY) {
    /* per-event unit of work — a crash here leaves the cursor BEFORE
     * this event, so the next run redoes exactly the unwritten ones */
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      for (const w of writes) {
        entUpdates +=
          (
            await c.query(
              `UPDATE event_entities
                SET role = $3, prominence = $4,
                    prominence_method = $5, prominence_evidence = $6
              WHERE event_id = $1 AND entity_slug = $2`,
              [
                e.id,
                w.slug,
                w.role,
                w.prominence,
                METHOD,
                JSON.stringify(w.evidence),
              ],
            )
          ).rowCount ?? 0;
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      failedIds.add(e.id);
      console.error(`enrich ${e.id}:`, (err as Error).message);
    } finally {
      c.release();
    }
  }
  processed++;
  /* cursor correctness: the watermark covers only the contiguous
   * successful prefix — a failed event is never jumped over; the next
   * run's cursor makes it retry exactly the events that failed */
  const cursor = checkpointCursor(
    events.map((r) => ({ id: r.id, lastSeenAt: r.last_seen_at })),
    failedIds,
    since,
  );
  if (run && processed % 50 === 0)
    await updateJob(run.id, {
      processed,
      failed: failedIds.size,
      cursorTs: cursor,
    });
}

console.log(
  `enriched: ${processed} events, ${entUpdates} entity rows, ${failedIds.size} failed`,
);
const cursor = checkpointCursor(
  events.map((r) => ({ id: r.id, lastSeenAt: r.last_seen_at })),
  failedIds,
  since,
);
if (run)
  await finishJob(run.id, {
    processed: processed - failedIds.size,
    failed: failedIds.size,
    cursorTs: cursor,
  });
await db.end();
