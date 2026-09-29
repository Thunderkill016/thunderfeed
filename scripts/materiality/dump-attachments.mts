/* R7.1d.3a — claim↔event attachment corpus. Offline diagnostic dump:
 * for a stratified event set, every claim + its materiality + every
 * evidence doc backing it + every event that doc is attached to.
 * Feeds human labeling into 4 classes:
 *   driver / on_topic_non_driver / misclustered / extraction_gap
 * NOTHING here is scored — it is a provenance snapshot only. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const env = readFileSync(".env.local", "utf8");
const pass = env.match(/SUPABASE_DB_PASS=(.+)/)![1].trim();
const url = `postgresql://postgres.vwpudirxzaxhbczknaan:${pass}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

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
  await pool.query(
    `SELECT c.event_id::text id, count(*)::int n
       FROM claims c JOIN events e ON e.id = c.event_id
      WHERE e.status NOT IN ('merged','archived')
      GROUP BY c.event_id ORDER BY n DESC LIMIT 8`,
  )
).rows.map((r) => r.id);
const controls = (
  await pool.query(
    `SELECT c.event_id::text id, count(*)::int n
       FROM claims c JOIN events e ON e.id = c.event_id
      WHERE e.status NOT IN ('merged','archived')
      GROUP BY c.event_id HAVING count(*) BETWEEN 1 AND 3
      ORDER BY c.event_id LIMIT 10`,
  )
).rows.map((r) => r.id);

const eventIds = [...new Set([...reviewed, ...hifp, ...giants, ...controls])];
console.log(
  `events: reviewed=${reviewed.length} hifp=${hifp.length} giants=${giants.length} controls=${controls.length} → union=${eventIds.length}`,
);

// ── dump ──
const ph = eventIds.map((_, i) => `$${i + 1}`).join(",");
const { rows: evs } = await pool.query(
  `SELECT e.id::text, e.topic, e.status::text, ev.title
     FROM events e LEFT JOIN event_versions ev ON ev.id = e.current_version_id
    WHERE e.id IN (${ph}) ORDER BY e.id`,
  eventIds,
);
const { rows: claims } = await pool.query(
  `SELECT c.id::text, c.event_id::text, c.claim_key, c.predicate,
          c.subject_entity_id::text, ent.canonical_key AS subject_key,
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
// claim → evidence docs (via current version) with doc's event attachments
const { rows: evLinks } = await pool.query(
  `SELECT ce.claim_version_id::text, ev.id::text AS ev_id,
          ed.id::text AS doc_id, ev.title AS doc_title,
          s.name AS source, ed.canonical_url, ed.published_at,
          (SELECT jsonb_agg(jsonb_build_object(
             'event', ee.event_id::text, 'by', ee.attached_by::text,
             'score', ee.cluster_score, 'detached', ee.detached_at IS NOT NULL))
             FROM event_evidence ee
             JOIN evidence_versions v ON v.id = ee.evidence_version_id
            WHERE v.document_id = ed.id) AS doc_events
     FROM claim_evidence ce
     JOIN claim_versions cv ON cv.id = ce.claim_version_id
     JOIN claims c ON c.id = cv.claim_id AND c.current_version_id = cv.id
     JOIN evidence_versions ev ON ev.id = ce.evidence_version_id
     JOIN evidence_documents ed ON ed.id = ev.document_id
     JOIN sources s ON s.id = ed.source_id
    WHERE c.event_id IN (${ph})`,
  eventIds,
);
// merge-path telemetry per event: which resolver path pulled clusters in.
// Diagnostic only — cluster→event grain, not doc→event; used by the
// root-cause audit, never by the label logic.
const { rows: mergeRows } = await pool.query(
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

const byClaimVersion = new Map<string, any[]>();
for (const r of evLinks) {
  const k = r.claim_version_id;
  (byClaimVersion.get(k) ?? byClaimVersion.set(k, []).get(k)!).push(r);
}
// need claim_version_id on the claim rows — fetch current_version_id map
const { rows: cvMap } = await pool.query(
  `SELECT id::text, current_version_id::text FROM claims WHERE event_id IN (${ph})`,
  eventIds,
);
const cvOf = new Map(cvMap.map((r: any) => [r.id, r.current_version_id]));

const corpus = {
  generatedAt: new Date().toISOString(),
  purpose: "R7.1d.3a claim↔event attachment labeling + root-cause audit",
  classes: ["driver", "on_topic_non_driver", "misclustered"],
  eventFlag: "extraction_gap",
  events: evs.map((e) => ({
    eventId: e.id,
    topic: e.topic,
    status: e.status,
    title: e.title,
    mergePaths: mergePaths.get(e.id) ?? {},
    claims: claims
      .filter((c) => c.event_id === e.id)
      .map((c) => ({
        claimId: c.id,
        claimKey: c.claim_key,
        predicate: c.predicate,
        subjectKey: c.subject_key,
        value: c.value,
        unit: c.unit,
        state: c.state,
        changeType: c.change_type,
        materiality: c.materiality,
        evidence: (byClaimVersion.get(cvOf.get(c.id) ?? "") ?? []).map((d) => ({
          docTitle: d.doc_title,
          source: d.source,
          url: d.canonical_url,
          publishedAt: d.published_at,
          docEvents: d.doc_events ?? [],
        })),
      })),
  })),
};
const idsHash = createHash("sha256")
  .update(
    corpus.events
      .flatMap((e) => e.claims.map((c) => c.claimId))
      .sort()
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 16);
(corpus as any).claimIdsHash = idsHash;
writeFileSync(
  "tests/fixtures/attachment-corpus.json",
  JSON.stringify(corpus, null, 1),
);
const totalClaims = corpus.events.reduce((n, e) => n + e.claims.length, 0);
console.log(
  `events=${corpus.events.length} claims=${totalClaims} idsHash=${idsHash}`,
);
console.log("wrote tests/fixtures/attachment-corpus.json");
await pool.end();
