/* R7.1d.3a.1 — claim↔event attachment corpus, STANDING-EVIDENCE grain.
 *
 * Offline diagnostic dump. For a stratified event set: every claim with
 * its materiality assessment + the documents that actually back the
 * claim's STANDING position — computed by the SAME canonical accessor
 * production uses (standingEvidenceByClaim, lib/db/adjudicate.ts):
 * latest vote per lineage-root origin → standingClaimPos → backing docs.
 * Evidence is claim-version-scoped and never carried forward, so a
 * current-version-only join silently loses provenance (the 3a bug).
 *
 * Also snapshots EVENT-level evidence (docs attached via event_evidence,
 * including ones backing no surviving claim — extraction-gap evidence),
 * merge-path telemetry, and pins a semantic corpusHash over every input
 * the labels consume. NOTHING here is scored — provenance snapshot only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { injectPool } from "../../lib/db/pool.ts";
import { standingEvidenceByClaim } from "../../lib/db/adjudicate.ts";
import { attachmentCorpusHash } from "./attachment-hash.ts";

const env = readFileSync(".env.local", "utf8");
const pass = env.match(/SUPABASE_DB_PASS=(.+)/)![1].trim();
const url = `postgresql://postgres.vwpudirxzaxhbczknaan:${pass}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
/* the db layer is pointed at this prod pool so helper reads that DO use
 * getPool() resolve here; the tx client below is still threaded through
 * every read explicitly (latestLineage honours the caller's client) */
injectPool(pool);

/* R7.1d.3a.2 — the whole corpus is ONE point-in-time snapshot. Prod has
 * scheduled writers; without a REPEATABLE READ tx the corpus could mix
 * claim pointers at t0, evidence at t1 and resolver telemetry at t2 —
 * and the semantic hash would certify a state the DB never had. Every
 * query below runs on this client inside the same snapshot. */
const client = await pool.connect();
await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

// ── event selection: reviewed ∪ high-FP ∪ giant clusters ∪ clean controls ──
const labels = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-labels.json", "utf8"),
).labels as any[];
const reviewed = labels
  .filter((e) => e.driversReviewed || e.channelsReviewed || e.targetsReviewed)
  .map((e) => e.eventId);
const hifp = labels
  .filter((e) => e.fpCause === "upstream_miscluster")
  .map((e) => e.eventId);

const giants = (
  await client.query(
    `SELECT c.event_id::text id, count(*)::int n
       FROM claims c JOIN events e ON e.id = c.event_id
      WHERE e.status NOT IN ('merged','archived')
      GROUP BY c.event_id ORDER BY n DESC LIMIT 8`,
  )
).rows.map((r) => r.id);
const controls = (
  await client.query(
    `SELECT c.event_id::text id, count(*)::int n
       FROM claims c JOIN events e ON e.id = c.event_id
      WHERE e.status NOT IN ('merged','archived')
      GROUP BY c.event_id HAVING count(*) BETWEEN 1 AND 3
      ORDER BY c.event_id LIMIT 10`,
  )
).rows.map((r) => r.id);

/* 3b.2a — extra event ids (e.g. resolver goldSampling candidates) can be
 * appended via argv so targeted gold review joins the same snapshot:
 *   dump-attachments.mts [event-id ...] */
const extra = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/i.test(a));
const eventIds = [
  ...new Set([...reviewed, ...hifp, ...giants, ...controls, ...extra]),
];
console.log(
  `events: reviewed=${reviewed.length} hifp=${hifp.length} giants=${giants.length} controls=${controls.length} extra=${extra.length} → union=${eventIds.length}`,
);

// ── dump ──
const ph = eventIds.map((_, i) => `$${i + 1}`).join(",");
const { rows: evs } = await client.query(
  `SELECT e.id::text, e.topic, e.status::text,
          e.current_version_id::text AS event_version_id, ev.title
     FROM events e LEFT JOIN event_versions ev ON ev.id = e.current_version_id
    WHERE e.id IN (${ph}) ORDER BY e.id`,
  eventIds,
);
const { rows: claims } = await client.query(
  `SELECT c.id::text, c.event_id::text, c.claim_key, c.predicate,
          c.subject_entity_id::text, ent.canonical_key AS subject_key,
          c.current_version_id::text AS current_version_id,
          cv.value, cv.unit, cv.state::text, cv.change_type::text,
          p.assessment_id::text, a.assessment->>'materiality' AS materiality
     FROM claims c
     LEFT JOIN entities ent ON ent.id = c.subject_entity_id
     LEFT JOIN claim_versions cv ON cv.id = c.current_version_id
     LEFT JOIN claim_materiality_current p ON p.claim_id = c.id
     LEFT JOIN claim_materiality_assessments a ON a.id = p.assessment_id
    WHERE c.event_id IN (${ph})
    ORDER BY c.event_id, c.id`,
  eventIds,
);

/* STANDING evidence per claim — the shared accessor. Returns docs behind
 * latest-per-origin votes on the standing position across ALL claim
 * versions; votes whose latest assertion moved elsewhere are excluded. */
const standingByClaim = await standingEvidenceByClaim(
  client,
  claims.map((c) => c.id),
);
const standingEvIds = [
  ...new Set(
    [...standingByClaim.values()].flatMap((s) =>
      s.standing.map((r) => r.evidenceVersionId),
    ),
  ),
];

// event-level evidence snapshot — every doc attached to a corpus event,
// detached edges kept visible (detached=true) but never counted active
const { rows: eventDocs } = await client.query(
  `SELECT ee.event_id::text, ee.evidence_version_id::text AS ev_id,
          ev.document_id::text AS doc_id, ev.title AS doc_title,
          s.name AS source, ed.canonical_url, ed.published_at,
          ev.observed_at, ee.attached_by::text, ee.cluster_score,
          (ee.detached_at IS NOT NULL) AS detached
     FROM event_evidence ee
     JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
     JOIN evidence_documents ed ON ed.id = ev.document_id
     JOIN sources s ON s.id = ed.source_id
    WHERE ee.event_id IN (${ph})`,
  eventIds,
);

/* hydrate standing docs + ACTIVE event fanout for every doc appearing in
 * the corpus (standing ∪ event-level). Detached edges never count — a
 * doc detached elsewhere is not "sprayed" there. */
const { rows: standingDocRows } = standingEvIds.length
  ? await client.query(
      `SELECT DISTINCT ev.document_id::text AS doc_id
         FROM evidence_versions ev
        WHERE ev.id IN (${standingEvIds.map((_, i) => `$${i + 1}`).join(",")})`,
      standingEvIds,
    )
  : { rows: [] };
const allDocIds = [
  ...new Set([
    ...eventDocs.map((d) => d.doc_id),
    ...standingDocRows.map((r) => r.doc_id),
  ]),
];
const { rows: docMeta } = allDocIds.length
  ? await client.query(
      `SELECT ed.id::text AS doc_id, ev.id::text AS ev_id, ev.title AS doc_title,
              s.name AS source, ed.canonical_url, ed.published_at, ev.observed_at
         FROM evidence_versions ev
         JOIN evidence_documents ed ON ed.id = ev.document_id
         JOIN sources s ON s.id = ed.source_id
        WHERE ed.id IN (${allDocIds.map((_, i) => `$${i + 1}`).join(",")})
        ORDER BY ev.observed_at DESC`,
      allDocIds,
    )
  : { rows: [] };
const { rows: fanout } = allDocIds.length
  ? await client.query(
      `SELECT DISTINCT v.document_id::text AS doc_id,
              ee.event_id::text AS event_id
         FROM event_evidence ee
         JOIN evidence_versions v ON v.id = ee.evidence_version_id
        WHERE v.document_id IN (${allDocIds.map((_, i) => `$${i + 1}`).join(",")})
          AND ee.detached_at IS NULL`,
      allDocIds,
    )
  : { rows: [] };

const activeEventsByDoc = new Map<string, string[]>();
for (const f of fanout)
  (
    activeEventsByDoc.get(f.doc_id) ??
    activeEventsByDoc.set(f.doc_id, []).get(f.doc_id)!
  ).push(f.event_id);
for (const v of activeEventsByDoc.values()) v.sort();

// doc meta keyed by evidence_version_id — standing rows pin a version
const byEvId = new Map<string, (typeof docMeta)[number]>();
for (const m of docMeta) if (!byEvId.has(m.ev_id)) byEvId.set(m.ev_id, m);

const { rows: mergeRows } = await client.query(
  `SELECT chosen_event_id::text AS event_id, path, count(*)::int n
     FROM resolver_decisions
    WHERE chosen_event_id IN (${ph}) AND decision = 'merge'
    GROUP BY chosen_event_id, path`,
  eventIds,
);
const mergePaths = new Map<string, Record<string, number>>();
for (const r of mergeRows) {
  const m = mergePaths.get(r.event_id) ?? {};
  m[r.path] = r.n;
  mergePaths.set(r.event_id, m);
}

const eventDocsByEvent = new Map<string, typeof eventDocs>();
for (const d of eventDocs)
  (
    eventDocsByEvent.get(d.event_id) ??
    eventDocsByEvent.set(d.event_id, []).get(d.event_id)!
  ).push(d);

const claimsByEvent = new Map<string, typeof claims>();
for (const c of claims)
  (
    claimsByEvent.get(c.event_id) ??
    claimsByEvent.set(c.event_id, []).get(c.event_id)!
  ).push(c);

const corpus = {
  generatedAt: new Date().toISOString(),
  purpose: "R7.1d.3a.1 claim↔event attachment labeling + root-cause audit",
  classes: ["driver", "on_topic_non_driver", "misclustered"],
  eventFlag: "extraction_gap",
  events: evs.map((e) => ({
    eventId: e.id,
    eventVersionId: e.event_version_id,
    topic: e.topic,
    status: e.status,
    title: e.title,
    mergePaths: mergePaths.get(e.id) ?? {},
    eventEvidence: (eventDocsByEvent.get(e.id) ?? []).map((d) => ({
      documentId: d.doc_id,
      evidenceVersionId: d.ev_id,
      title: d.doc_title,
      source: d.source,
      url: d.canonical_url,
      publishedAt: d.published_at,
      observedAt: d.observed_at,
      attachedBy: d.attached_by,
      clusterScore: d.cluster_score,
      detached: d.detached,
      activeEvents: activeEventsByDoc.get(d.doc_id) ?? [],
    })),
    claims: (claimsByEvent.get(e.id) ?? []).map((c) => {
      const se = standingByClaim.get(c.id);
      return {
        claimId: c.id,
        claimKey: c.claim_key,
        predicate: c.predicate,
        subjectKey: c.subject_key,
        value: c.value,
        unit: c.unit,
        state: c.state,
        changeType: c.change_type,
        currentClaimVersionId: c.current_version_id,
        materialityAssessmentId: c.assessment_id,
        materiality: c.materiality,
        standingPos: se?.standingPos ?? null,
        standingEvidence: (se?.standing ?? []).map((r) => {
          const m = byEvId.get(r.evidenceVersionId);
          return {
            documentId: r.docId,
            evidenceVersionId: r.evidenceVersionId,
            title: m?.doc_title ?? null,
            source: m?.source ?? null,
            url: m?.canonical_url ?? null,
            publishedAt: m?.published_at ?? null,
            activeEvents: activeEventsByDoc.get(r.docId) ?? [],
          };
        }),
      };
    }),
  })),
};

/* corpusHash — semantic snapshot pin (shared canonicalizer). Event ids
 * alone stay identical across re-dumps while provenance drifts; this
 * hash covers every input the labels/metrics consume. generatedAt
 * excluded: same semantic input → same hash. Shuffle-stable. */
const corpusHash = attachmentCorpusHash(corpus.events);
(corpus as any).corpusHash = corpusHash;

writeFileSync(
  "tests/fixtures/attachment-corpus.json",
  JSON.stringify(corpus, null, 1),
);
const totalClaims = corpus.events.reduce((n, e) => n + e.claims.length, 0);
const standingDocs = corpus.events.reduce(
  (n, e) => n + e.claims.reduce((m, c) => m + c.standingEvidence.length, 0),
  0,
);
console.log(
  `events=${corpus.events.length} claims=${totalClaims} standingDocs=${standingDocs} corpusHash=${corpusHash}`,
);
console.log("wrote tests/fixtures/attachment-corpus.json");
await client.query("COMMIT");
client.release();
await pool.end();
