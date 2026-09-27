/* R6 adjudication runner — moves reported claims to
 * supported/disputed/unresolved for the events currently on Radar.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/adjudicate.mts [--events N] [--dry]
 *
 * Scope: the N most recent live events (default 30 — the Radar surface).
 * Rules live in lib/db/adjudicate.ts; state changes are append-only
 * (new claim_versions rows), never UPDATE. */
import { getPool } from "../../lib/db/pool.ts";
import { adjudicateEvents } from "../../lib/db/adjudicate.ts";

const args = process.argv.slice(2);
const evIdx = args.indexOf("--events");
const EVENTS = evIdx >= 0 ? Number(args[evIdx + 1]) : 30;
const DRY = args.includes("--dry");

const db = getPool();
const { rows } = await db.query<{ id: string; title: string }>(
  `SELECT id, title FROM (
     SELECT e.id, ev.title, e.last_seen_at
     FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
     WHERE e.status NOT IN ('merged','archived')
     ORDER BY e.last_seen_at DESC LIMIT $1
   ) t`,
  [EVENTS],
);
console.log(`adjudicate: ${rows.length} events${DRY ? " (dry)" : ""}`);

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
await db.end();
