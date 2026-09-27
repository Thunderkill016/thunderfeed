/* R6 enrichment backfill — wire-copy clusters + entity prominence.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/enrich.mts [--limit N] [--dry]
 *
 * For every live event:
 *   1. cluster its evidence documents by normalized-title shingles and
 *      write evidence_documents.independence_key (same wire → same key);
 *   2. score each event_entities row (title hit / doc-title share / claim
 *      subject) and write role + prominence.
 *
 * Idempotent — re-running recomputes from the current evidence set. */
import { getPool } from "../../lib/db/pool.ts";
import { clusterByTitles, prominenceFor } from "../../lib/enrich.ts";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 500;
const DRY = args.includes("--dry");

const db = getPool();

const { rows: events } = await db.query<{
  id: string;
  title: string;
}>(
  `SELECT e.id, ev.title
   FROM events e JOIN event_versions ev ON ev.id = e.current_version_id
   WHERE e.status NOT IN ('merged','archived')
   ORDER BY e.last_seen_at DESC
   LIMIT $1`,
  [LIMIT],
);
console.log(`enrich: ${events.length} events${DRY ? " (dry)" : ""}`);
if (events.length === 0) process.exit(0);
const ids = events.map((e) => e.id);

/* evidence docs per event — current version's headline + document id */
const { rows: docs } = await db.query<{
  event_id: string;
  doc_id: string;
  title: string;
  published_at: string | null;
}>(
  `SELECT ee.event_id, ed.id AS doc_id,
          COALESCE(ev.title, '') AS title, ed.published_at
   FROM event_evidence ee
   JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
   JOIN evidence_documents ed ON ed.id = ev.document_id
   WHERE ee.event_id = ANY($1)`,
  [ids],
);

const { rows: entRows } = await db.query<{
  event_id: string;
  entity_slug: string;
}>(
  `SELECT event_id, entity_slug FROM event_entities WHERE event_id = ANY($1)`,
  [ids],
);

/* claim subjects → canonical keys (entities.canonical_key, mapped back to
 * gazetteer slugs is unnecessary — we compare on canonical_key space) */
const { rows: claimSubs } = await db.query<{
  event_id: string;
  canonical_key: string;
}>(
  `SELECT DISTINCT c.event_id, en.canonical_key
   FROM claims c JOIN entities en ON en.id = c.subject_entity_id
   WHERE c.event_id = ANY($1)`,
  [ids],
);
const subjectsByEvent = new Map<string, Set<string>>();
for (const r of claimSubs) {
  if (!subjectsByEvent.has(r.event_id))
    subjectsByEvent.set(r.event_id, new Set());
  subjectsByEvent.get(r.event_id)!.add(r.canonical_key);
}

let docUpdates = 0;
let entUpdates = 0;
const docBatch: { id: string; key: string }[] = [];
const entBatch: { event: string; slug: string; role: string; prom: number }[] =
  [];

for (const e of events) {
  const evDocs = docs.filter((d) => d.event_id === e.id && d.title);
  const clusters = clusterByTitles(
    evDocs.map((d) => ({
      id: d.doc_id,
      title: d.title,
      publishedAt: d.published_at ?? undefined,
    })),
  );
  for (const [docId, key] of clusters) docBatch.push({ id: docId, key });

  const docTitles = evDocs.map((d) => d.title);
  const subjects = subjectsByEvent.get(e.id) ?? new Set<string>();
  for (const er of entRows.filter((r) => r.event_id === e.id)) {
    const p = prominenceFor({
      slug: er.entity_slug,
      eventTitle: e.title,
      docTitles,
      claimSubjectKeys: subjects,
    });
    entBatch.push({
      event: e.id,
      slug: er.entity_slug,
      role: p.role,
      prom: p.prominence,
    });
  }
}

/* a doc can attach to several events — one key per doc regardless */
const docSeen = new Map<string, string>();
const docUnique = docBatch.filter((d) => {
  if (docSeen.has(d.id)) return false;
  docSeen.set(d.id, d.key);
  return true;
});

console.log(
  `computed: ${docUnique.length} doc keys, ${entBatch.length} entity roles`,
);
if (!DRY) {
  /* small committed chunks — the live ingest writer updates
   * evidence_documents.last_seen_at concurrently, and one giant txn
   * deadlocks against it (observed: 40P01 on tuple update). Chunk size
   * trades per-statement overhead for a lock window shorter than the
   * writer's own batch. */
  const CHUNK = 300;
  const withRetry = async (fn: () => Promise<number>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if ((e as { code?: string }).code === "40P01" && attempt < 5) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  };
  for (let off = 0; off < docUnique.length; off += CHUNK) {
    const slice = docUnique.slice(off, off + CHUNK);
    docUpdates += await withRetry(async () => {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        let n = 0;
        for (const d of slice) {
          const r = await c.query(
            `UPDATE evidence_documents SET independence_key = $2 WHERE id = $1`,
            [d.id, d.key],
          );
          n += r.rowCount ?? 0;
        }
        await c.query("COMMIT");
        return n;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    });
    if (off % 3000 === 0) console.log(`  docs ${off}/${docUnique.length}`);
  }
  for (const en of entBatch) {
    entUpdates += await withRetry(async () => {
      const r = await db.query(
        `UPDATE event_entities SET role = $3, prominence = $4
         WHERE event_id = $1 AND entity_slug = $2`,
        [en.event, en.slug, en.role, en.prom],
      );
      return r.rowCount ?? 0;
    });
  }
}
console.log(`updated: ${docUpdates} docs, ${entUpdates} entity rows`);
await db.end();
