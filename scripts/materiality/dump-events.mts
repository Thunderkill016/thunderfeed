/* R7.1d — freeze an EVENT-level corpus for the event-materiality lab.
 *
 * Unit = logical event (events.current_version_id title for review),
 * claims = the event's CURRENT claim_materiality assessments joined
 * from claim_materiality_current — we aggregate the persisted truth,
 * never re-score claims. Same corpus ⇒ same aggregation output.
 *
 *   DATABASE_URL=… npx tsx scripts/materiality/dump-events.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

import { getPool } from "../../lib/db/pool.ts";

const METHOD_VERSION = "r7.1d";
const SELECTION_VERSION = "events-v1";

async function main() {
  const db = getPool();
  const { rows } = await db.query<{
    event_id: string;
    title: string;
    topic: string;
    claim_id: string;
    predicate: string;
    claim_state: string;
    assessment_id: string;
    assessment: unknown;
  }>(
    `SELECT e.id AS event_id,
            ev.title,
            e.topic,
            c.id AS claim_id,
            c.predicate,
            cv.state AS claim_state,
            a.id AS assessment_id,
            a.assessment
       FROM events e
       JOIN event_versions ev ON ev.id = e.current_version_id
       JOIN claims c ON c.event_id = e.id
       JOIN claim_versions cv ON cv.id = c.current_version_id
       JOIN claim_materiality_current p ON p.claim_id = c.id
       JOIN claim_materiality_assessments a ON a.id = p.assessment_id
      ORDER BY e.id, c.id`,
  );

  /* legacy-comparison inputs: the event's own predicate bag + entity rows,
   * frozen alongside the assessments so bench-events can replay R7.0's
   * scoreEventMateriality on identical corpus without touching prod. */
  const { rows: entRows } = await db.query<{
    event_id: string;
    entity_slug: string;
    entity_type: string;
  }>(
    `SELECT ee.event_id,
            COALESCE(en.canonical_key, ee.entity_slug) AS entity_slug,
            COALESCE(en.entity_type, 'other') AS entity_type
       FROM event_entities ee
       LEFT JOIN entities en ON en.id = ee.entity_id`,
  );
  const entsByEvent = new Map<string, { slug: string; type: string }[]>();
  for (const r of entRows) {
    const l = entsByEvent.get(r.event_id) ?? [];
    l.push({ slug: r.entity_slug, type: r.entity_type });
    entsByEvent.set(r.event_id, l);
  }

  const byEvent = new Map<
    string,
    {
      eventId: string;
      title: string;
      topic: string;
      entities: { slug: string; type: string }[];
      predicates: string[];
      claims: {
        claimId: string;
        predicate: string;
        claimState: string;
        assessmentId: string;
        assessment: unknown;
      }[];
    }
  >();
  for (const r of rows) {
    let e = byEvent.get(r.event_id);
    if (!e) {
      e = {
        eventId: r.event_id,
        title: r.title,
        topic: r.topic,
        entities: [],
        predicates: [],
        claims: [],
      };
      byEvent.set(r.event_id, e);
    }
    if (!e.predicates.includes(r.predicate)) e.predicates.push(r.predicate);
    e.claims.push({
      claimId: r.claim_id,
      predicate: r.predicate,
      claimState: r.claim_state,
      assessmentId: r.assessment_id,
      assessment: r.assessment,
    });
  }
  const items = [...byEvent.values()]
    .map((e) => ({
      ...e,
      entities: (entsByEvent.get(e.eventId) ?? []).sort((a, b) =>
        a.slug.localeCompare(b.slug),
      ),
      predicates: [...e.predicates].sort(),
    }))
    .sort((a, b) => a.eventId.localeCompare(b.eventId));

  /* corpusHash pins the SEMANTIC snapshot — event ids alone would stay
   * identical across re-dumps even when underlying claim assessments
   * changed, silently moving the labeled benchmark onto a different input.
   * generatedAt is excluded: same semantic input → same hash. */
  const canonical = items.map((e) => ({
    eventId: e.eventId,
    topic: e.topic,
    predicates: e.predicates,
    entities: e.entities,
    claims: e.claims
      .map((c) => ({ claimId: c.claimId, assessmentId: c.assessmentId }))
      .sort((a, b) => a.claimId.localeCompare(b.claimId)),
  }));
  const corpusHash = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);

  const corpus = {
    generatedAt: new Date().toISOString(),
    methodVersion: METHOD_VERSION,
    selectionVersion: SELECTION_VERSION,
    eventCount: items.length,
    claimCount: rows.length,
    corpusHash,
    items,
  };
  writeFileSync(
    "tests/fixtures/materiality-events-corpus.json",
    JSON.stringify(corpus, null, 2),
  );
  const dist: Record<string, number> = {};
  for (const i of items) {
    const n = i.claims.length;
    dist[n > 50 ? ">50" : n > 10 ? "11-50" : n > 3 ? "4-10" : "1-3"] =
      (dist[n > 50 ? ">50" : n > 10 ? "11-50" : n > 3 ? "4-10" : "1-3"] ?? 0) +
      1;
  }
  console.log(
    `events=${items.length} claims=${rows.length} corpusHash=${corpusHash}`,
    dist,
  );
  await db.end();
}

await main();
