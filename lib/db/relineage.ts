/* Batch lineage reconciliation — reclassify documents using the ingest
 * classifier (lib/lineage.ts classifyLineage) over the UNION pool of
 * every event a document belongs to.
 *
 * R6.1: targets docs whose latest relation is 'unknown' or missing.
 * R6.1b reconciliation: ALSO re-evaluates docs asserted 'original' —
 * a late-arriving older sibling is normal in a news pipeline, and if it
 * proves the doc was actually derived, provenance must correct itself
 * via a new append-only version. 'original' that still beats the pool
 * classifies identically → nothing minted. Docs with a DERIVED relation
 * keep their stored parent (it defends itself via the outside-pool
 * rule below); repointing derived parents is not this job's scope.
 *
 * Rules carried verbatim from the ingest lineage pass (writer.ts):
 *   - candidates = sibling docs attached to the same event(s)
 *   - a stored derived parent living outside the pool re-enters it to
 *     defend its assertion; if the contest can't beat it the recorded
 *     provenance is KEPT, never blindly downgraded to 'unknown'
 *   - only a real classification change mints: append-only lineage
 *     version_no+1 with supersedes_lineage_id — history never rewritten
 *   - batch rows carry classifier_version 'v3' + evidence.relineage so
 *     ingest-minted and batch-minted lineage stay distinguishable
 *
 * Per-event write transactions: a failed event is reported in
 * failedEventIds so the caller's job cursor can freeze before it. */
import type pg from "pg";
import { getPool, toJsonb } from "./pool";
import { enqueueDirty } from "./jobs";
import {
  classifyLineage,
  resolveOrigins,
  type LineageAssertion,
  type LineageDoc,
} from "../lineage";

export const BATCH_TAG = "v3"; // batch reclassification generation (audit)

const DERIVED = new Set([
  "syndicated",
  "rewritten",
  "quoted",
  "press_release_based",
]);

/** Relations eligible for batch (re-)evaluation: unclassified, unknown,
 *  and 'original' claims — an original assertion must survive a fresh
 *  look at the CURRENT pool, or be corrected by a new version. */
const REEVALUATABLE = new Set(["unknown", "original"]);

export async function relineageEvents(
  eventIds: string[],
  opts: { dryRun?: boolean } = {},
): Promise<{
  minted: number;
  resolved: number;
  failedEventIds: string[];
  /** events whose lineage actually changed — hand-off to adjudication */
  changedEventIds: string[];
}> {
  const db = getPool();
  const result = {
    minted: 0,
    resolved: 0,
    failedEventIds: [] as string[],
    changedEventIds: [] as string[],
  };
  if (!eventIds.length) return result;

  /* every attached doc of the events — classification pool */
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
      WHERE ee.event_id IN (${eventIds.map((_, i) => `$${i + 1}`).join(",")})`,
    eventIds,
  );
  /* A doc may be attached to events OUTSIDE this sweep — its union pool
   * must include those siblings (otherwise a wire parent living only on
   * a non-swept event is invisible and the doc can never be corrected).
   * Expand: find every event any pool doc touches, then load those
   * events' docs as pool context (they never become targets). */
  const sweptEventIds = new Set(eventIds);
  const sweptDocIds = [...new Set(docs.map((d) => d.id))];
  const extraEventIds = sweptDocIds.length
    ? (
        await db.query<{ event_id: string }>(
          `SELECT DISTINCT ee.event_id FROM event_evidence ee
             JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
            WHERE ev.document_id IN (${sweptDocIds
              .map((_, i) => `$${i + 1}`)
              .join(",")})`,
          sweptDocIds,
        )
      ).rows
        .map((r) => r.event_id)
        .filter((id) => !sweptEventIds.has(id))
    : [];
  if (extraEventIds.length) {
    const { rows: extraDocs } = await db.query<(typeof docs)[number]>(
      `SELECT DISTINCT ee.event_id, d.id, s.name AS source, s.kind::text AS kind,
              v.title, v.summary, d.published_at, d.canonical_url, s.language
         FROM event_evidence ee
         JOIN evidence_versions v ON v.id = ee.evidence_version_id
         JOIN evidence_documents d ON d.id = v.document_id
         JOIN sources s ON s.id = d.source_id
        WHERE ee.event_id IN (${extraEventIds
          .map((_, i) => `$${i + 1}`)
          .join(",")})`,
      extraEventIds,
    );
    docs.push(...extraDocs);
  }

  const docsByEvent = new Map<string, LineageDoc[]>();
  const docPool = new Map<string, LineageDoc>();
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
    docPool.set(d.id, ld);
  }

  /* latest lineage per doc in the whole pool */
  const allDocIds = [...docPool.keys()];
  const { rows: linRows } = allDocIds.length
    ? await db.query<{
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
          WHERE child_document_id IN (${allDocIds.map((_, i) => `$${i + 1}`).join(",")})
          ORDER BY child_document_id, version_no DESC`,
        allDocIds,
      )
    : { rows: [] };
  const prevByDoc = new Map(linRows.map((r) => [r.child_document_id, r]));

  /* load a parent doc living outside the pool (stored provenance
   * defends itself — same rule as the ingest path) */
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
  for (const [eid, ds] of docsByEvent) {
    for (const d of ds) {
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

  for (const eid of eventIds) {
    const pool = docsByEvent.get(eid) ?? [];
    const targets = pool.filter((d) => {
      if (doneDocs.has(d.documentId)) return false;
      const rel = prevByDoc.get(d.documentId)?.relation;
      return rel === undefined || REEVALUATABLE.has(rel);
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
      for (const eid2 of docEvents.get(child.documentId) ?? [])
        for (const d of docsByEvent.get(eid2) ?? [])
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
    if (opts.dryRun) {
      result.minted += writes.length;
      result.resolved += writes.filter(
        (w) => w.asrt.relation !== "unknown",
      ).length;
      continue;
    }
    if (!writes.length) continue;
    /* per-event transaction — one event's failure can never strand or
     * misattribute another event's lineage writes */
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const dirtiedEvents = new Set<string>();
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
        result.minted++;
        if (w.asrt.relation !== "unknown") result.resolved++;
        /* a re-minted doc affects EVERY event it is attached to — the
         * claim truth on a sibling event may reference this doc's
         * evidence. Collect the full attachment set, not just the
         * current sweep event. */
        for (const eid2 of docEvents.get(w.docId) ?? [])
          dirtiedEvents.add(eid2);
      }
      /* also cover attachments OUTSIDE this sweep's event pool — a doc
       * shared with an event not in the current batch still needs
       * re-adjudication */
      const mintedDocIds = writes.map((w) => w.docId);
      const { rows: attached } = await c.query<{ event_id: string }>(
        `SELECT DISTINCT ee.event_id FROM event_evidence ee
           JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
          WHERE ev.document_id IN (${mintedDocIds
            .map((_, i) => `$${i + 1}`)
            .join(",")})`,
        mintedDocIds,
      );
      for (const r of attached) dirtiedEvents.add(r.event_id);
      /* atomic hand-off: the dirty marker commits WITH the lineage
       * write — adjudication cannot miss the correction even though
       * events.last_seen_at is untouched */
      for (const de of dirtiedEvents)
        await enqueueDirty(c, de, "adjudicate", "relineage");
      await c.query("COMMIT");
      result.changedEventIds.push(...dirtiedEvents);
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      result.failedEventIds.push(eid);
      console.error(`relineage ${eid}:`, (err as Error).message);
    } finally {
      c.release();
    }
  }
  return result;
}
