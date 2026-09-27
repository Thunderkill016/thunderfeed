/* R6.1 relineage — reclassify documents whose latest lineage relation
 * is 'unknown' (or never classified), reusing the ingest classifier
 * (lib/lineage.ts classifyLineage) over the SAME-EVENT document pool.
 *
 *   DATABASE_URL=... npx tsx scripts/radar/relineage.mts [--since ISO] [--limit N] [--dry]
 *
 *   --since defaults to the last successful job_runs cursor, else 7d.
 *
 * Rules carried verbatim from the ingest lineage pass (writer.ts):
 *   - candidates = sibling docs attached to the same event
 *   - a stored derived parent living outside this event's pool re-enters
 *     the pool to defend its assertion; if the contest can't beat it the
 *     recorded provenance is KEPT, never blindly downgraded to 'unknown'
 *   - only a real classification change mints: append-only lineage
 *     version_no+1 with supersedes_lineage_id — history is never
 *     rewritten
 *   - batch rows carry classifier_version 'v3' + evidence.relineage so
 *     ingest-minted and batch-minted lineage stay distinguishable
 *
 * Incremental + observable via job_runs; per-event transactions. */
import { getPool, toJsonb } from "../../lib/db/pool.ts";
import {
  CLASSIFIER_VERSION,
  classifyLineage,
  resolveOrigins,
  type LineageAssertion,
  type LineageDoc,
} from "../../lib/lineage.ts";
import {
  finishJob,
  lastDoneCursor,
  startJob,
  updateJob,
} from "../../lib/db/jobs.ts";

const BATCH_TAG = "v3"; // batch reclassification generation (audit)
const DEFAULT_WINDOW_H = 24 * 7; // first run: last week of changed events
const DERIVED = new Set([
  "syndicated",
  "rewritten",
  "quoted",
  "press_release_based",
]);

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
const eventIds = events.map((e) => e.id);

/* every attached doc of the changed events — classification pool */
const { rows: docs } = await db.query<{
  event_id: string;
  id: string;
  source: string;
  kind: string;
  title: string;
  summary: string | null;
  published_at: string | null;
  canonical_url: string;
  language: string | null;
}>(
  `SELECT DISTINCT ee.event_id, d.id, s.name AS source, s.kind::text AS kind,
          v.title, v.summary, d.published_at, d.canonical_url, s.language
     FROM event_evidence ee
     JOIN evidence_versions v ON v.id = ee.evidence_version_id
     JOIN evidence_documents d ON d.id = v.document_id
     JOIN sources s ON s.id = d.source_id
    WHERE ee.event_id = ANY($1)`,
  [eventIds],
);
const docsByEvent = new Map<string, LineageDoc[]>();
const docMeta = new Map<string, { source: string }>();
for (const d of docs) {
  const ld: LineageDoc = {
    documentId: d.id,
    source: d.source,
    sourceKind: d.kind,
    title: d.title,
    summary: d.summary ?? "",
    publishedAt: d.published_at ? new Date(d.published_at).toISOString() : "",
    url: d.canonical_url,
    language: d.language ?? undefined,
  };
  if (!docsByEvent.has(d.event_id)) docsByEvent.set(d.event_id, []);
  docsByEvent.get(d.event_id)!.push(ld);
  docMeta.set(d.id, { source: d.source });
}

/* latest lineage per doc in the whole pool */
const allDocIds = [...new Set(docs.map((d) => d.id))];
const { rows: linRows } = await db.query<{
  child_document_id: string;
  id: string;
  version_no: number;
  parent_document_id: string | null;
  relation: string;
}>(
  `SELECT DISTINCT ON (child_document_id)
          child_document_id, id, version_no, parent_document_id,
          relation::text
     FROM evidence_lineage
    WHERE child_document_id = ANY($1)
    ORDER BY child_document_id, version_no DESC`,
  [allDocIds],
);
const prevByDoc = new Map(linRows.map((r) => [r.child_document_id, r]));

/* load a parent doc living outside the pool (stored provenance defends
 * itself — same rule as the ingest path) */
async function loadDoc(id: string): Promise<LineageDoc | null> {
  const r = await db.query<{
    id: string;
    source: string;
    kind: string;
    title: string;
    summary: string | null;
    published_at: string | null;
    canonical_url: string;
    language: string | null;
  }>(
    `SELECT d.id, s.name AS source, s.kind::text AS kind,
            v.title, v.summary, d.published_at, d.canonical_url, s.language
       FROM evidence_documents d
       JOIN evidence_versions v ON v.id = d.current_version_id
       JOIN sources s ON s.id = d.source_id
      WHERE d.id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  docMeta.set(id, { source: row.source });
  return {
    documentId: row.id,
    source: row.source,
    sourceKind: row.kind,
    title: row.title,
    summary: row.summary ?? "",
    publishedAt: row.published_at
      ? new Date(row.published_at).toISOString()
      : "",
    url: row.canonical_url,
    language: row.language ?? undefined,
  };
}

/* docs are event-shared: a doc attached to X and Y must classify ONCE
 * against the UNION of both pools (per-event classification minted
 * duplicate version_no conflicts and made provenance depend on which
 * event ran first — the exact R6 independence_key bug) */
const docEvents = new Map<string, Set<string>>();
const docPool = new Map<string, LineageDoc>();
for (const [eid, ds] of docsByEvent) {
  for (const d of ds) {
    docPool.set(d.documentId, d);
    if (!docEvents.has(d.documentId)) docEvents.set(d.documentId, new Set());
    docEvents.get(d.documentId)!.add(eid);
  }
}
const doneDocs = new Set<string>();
/* assertion map seeds with stored relations and absorbs new mints so
 * resolveOrigins always walks the freshest chain */
const assertionMap = new Map<string, LineageAssertion>();
for (const p of prevByDoc.values()) {
  assertionMap.set(p.child_document_id, {
    parentDocumentId: p.parent_document_id,
    relation: p.relation as LineageAssertion["relation"],
    confidence: 1,
    method: "rule",
    evidence: {},
  });
}

let processed = 0;
let failed = 0;
let minted = 0;
let resolved = 0;
let cursor: string = since;

for (const e of events) {
  const pool = docsByEvent.get(e.id) ?? [];
  const targets = pool.filter((d) => {
    if (doneDocs.has(d.documentId)) return false;
    const rel = prevByDoc.get(d.documentId)?.relation;
    return rel === undefined || rel === "unknown";
  });
  const writes: {
    docId: string;
    asrt: LineageAssertion;
    prevId: string | null;
    versionNo: number;
  }[] = [];
  /* sorted like ingest: oldest document first so parents classify
   * before their reprints. Dedupe by documentId — a doc attached via
   * multiple evidence_versions appears twice in the pool. */
  const seen = new Set<string>();
  const ordered = [...targets]
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .filter((d) =>
      seen.has(d.documentId) ? false : (seen.add(d.documentId), true),
    );
  for (const child of ordered) {
    doneDocs.add(child.documentId);
    const prev = prevByDoc.get(child.documentId);
    /* union pool: sibling docs across EVERY event this doc belongs to */
    const poolIds = new Set<string>();
    for (const eid of docEvents.get(child.documentId) ?? [])
      for (const d of docsByEvent.get(eid) ?? [])
        if (d.documentId !== child.documentId) poolIds.add(d.documentId);
    const childPool = [...poolIds]
      .map((id) => docPool.get(id)!)
      .filter(Boolean);
    const parentAbsent =
      prev?.parent_document_id && !docPool.has(prev.parent_document_id);
    if (parentAbsent) {
      const oldParent = await loadDoc(prev!.parent_document_id!);
      if (!oldParent) continue; // unverifiable — never downgrade blind
      childPool.push(oldParent);
    }
    let asrt = classifyLineage(child, childPool);
    if (parentAbsent && !DERIVED.has(asrt.relation)) {
      asrt = {
        parentDocumentId: prev!.parent_document_id,
        relation: prev!.relation as LineageAssertion["relation"],
        confidence: 0,
        method: "rule",
        evidence: { reason: "kept_parent_outside_pool" },
      };
    }
    const changed =
      !prev ||
      prev.relation !== asrt.relation ||
      (prev.parent_document_id ?? null) !== (asrt.parentDocumentId ?? null);
    if (!changed) continue;
    assertionMap.set(child.documentId, asrt);
    writes.push({
      docId: child.documentId,
      asrt,
      prevId: prev?.id ?? null,
      versionNo: prev ? prev.version_no + 1 : 1,
    });
  }
  if (!DRY && writes.length) {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      for (const w of writes) {
        const origin = resolveOrigins(assertionMap).get(w.docId) ?? w.docId;
        await c.query(
          `INSERT INTO evidence_lineage
             (child_document_id, version_no, parent_document_id,
              origin_document_id, relation, confidence, method, evidence,
              classifier_version, supersedes_lineage_id)
           VALUES ($1, $2, $3, $4, $5::lineage_relation, $6, $7, $8::jsonb, $9, $10)`,
          [
            w.docId,
            w.versionNo,
            w.asrt.parentDocumentId,
            w.asrt.parentDocumentId ? origin : null,
            w.asrt.relation,
            w.asrt.confidence,
            w.asrt.method,
            toJsonb({ ...w.asrt.evidence, relineage: true }),
            BATCH_TAG,
            w.prevId,
          ],
        );
        minted++;
        if (w.asrt.relation !== "unknown") resolved++;
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      failed++;
      console.error(`relineage ${e.id}:`, (err as Error).message);
    } finally {
      c.release();
    }
  } else {
    minted += writes.length;
    resolved += writes.filter((w) => w.asrt.relation !== "unknown").length;
  }
  processed++;
  cursor = e.last_seen_at;
  if (run && processed % 50 === 0)
    await updateJob(run.id, { processed, failed, cursorTs: cursor });
}

console.log(
  `relineage: ${processed} events, ${minted} lineage versions minted, ${resolved} resolved${DRY ? " (dry)" : ""}`,
);
if (run) await finishJob(run.id, { processed, failed, cursorTs: cursor });
await db.end();
