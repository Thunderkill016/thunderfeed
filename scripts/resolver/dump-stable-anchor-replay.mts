/**
 * R7.1d.3b.2 — dump the stable-anchor replay corpus.
 *
 * Snapshot contract (R7.1d.3a discipline): ONE client, one
 * REPEATABLE READ READ ONLY transaction — every row is point-in-time
 * consistent; two dumps over an unchanged DB must hash identically.
 *
 * Replay unit = resolver decision (a cluster attaches via ONE decision,
 * N docs share it). Provenance rows are grouped by resolver_decision_id
 * and must agree on the decision payload (group invariant — spec §3.2);
 * a disagreeing group is marked group_invariant_violation, never
 * majority-voted.
 *
 *   node scripts/resolver/dump-stable-anchor-replay.mts <DATABASE_URL> [out]
 */
import pg from "pg";
import type { ReplayInput } from "../../lib/resolver-counterfactual.ts";
import type { ResolverThresholds } from "../../lib/resolver.ts";
import {
  deriveAnchors,
  groupProvenanceEdges,
  replayCorpusHash,
  type ProvenanceEdgeLike,
} from "./replay-corpus.ts";

const DB = process.argv[2] ?? process.env.DATABASE_URL;
const OUT = process.argv[3] ?? "tests/fixtures/resolver-replay-corpus.json";
if (!DB) throw new Error("DATABASE_URL required");

type Json = Record<string, unknown>;

const sorted = (a: string[]) => [...a].sort();
const arr = (v: unknown): string[] | null =>
  v === null || v === undefined ? null : (v as string[]);

async function main() {
  const db = new pg.Pool({ connectionString: DB });
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    /* ---------- provenance era boundary ---------- */
    const era = (
      await client.query<{ min: string | null }>(
        "SELECT min(created_at) min FROM event_attachment_provenance",
      )
    ).rows[0].min;
    if (!era) {
      console.error("no provenance rows — corpus empty");
      process.exit(1);
    }

    /* ---------- provenance edges grouped by decision ---------- */
    const edges = (
      await client.query<ProvenanceEdgeLike>(
        `SELECT resolver_decision_id, event_id, evidence_version_id,
                decision, path, incoming_cluster, candidate_event_id,
                cross_language,
                score, candidate_signature_hash_before,
                candidate_entities_before, candidate_core_entities_before,
                incoming_entities, incoming_core_entities,
                explanation, created_at
         FROM event_attachment_provenance
         ORDER BY resolver_decision_id, evidence_version_id`,
      )
    ).rows;

    const { winners, groupInvariantFailures } = groupProvenanceEdges(edges);

    /* ---------- the winner decision rows themselves ---------- */
    const decRows = (
      await client.query<{
        id: string;
        incoming_cluster: string | null;
        candidate_event_id: string | null;
        chosen_event_id: string | null;
        decision: string;
        path: string;
        score: number | null;
        features: Json;
        semantic_available: boolean;
        created_at: string;
      }>(
        `SELECT id, incoming_cluster, candidate_event_id, chosen_event_id,
                decision, path, score, features, semantic_available,
                created_at
         FROM resolver_decisions
         WHERE id = ANY($1::uuid[])`,
        [winners.map((w) => w.decisionId)],
      )
    ).rows;
    const decById = new Map(decRows.map((r) => [r.id, r]));

    /* ---------- non-winning decisions in the provenance era ---------- */
    const nonWinners = (
      await client.query<(typeof decRows)[0]>(
        `SELECT id, incoming_cluster, candidate_event_id, chosen_event_id,
                decision, path, score, features, semantic_available,
                created_at
         FROM resolver_decisions
         WHERE created_at >= $1 AND NOT (id = ANY($2::uuid[]))
         ORDER BY created_at, id`,
        [era, winners.map((w) => w.decisionId)],
      )
    ).rows;

    /* ---------- event topics (breakdown dimension) ---------- */
    const eventIds = [
      ...new Set(
        winners
          .map((w) => w.eventId)
          .concat(
            nonWinners.flatMap(
              (d) =>
                [d.chosen_event_id, d.candidate_event_id].filter(
                  Boolean,
                ) as string[],
            ),
          ),
      ),
    ];
    const topicRows = (
      await client.query<{ id: string; topic: string | null }>(
        "SELECT id, topic FROM events WHERE id = ANY($1::uuid[])",
        [eventIds],
      )
    ).rows;
    const topics = new Map(topicRows.map((r) => [r.id, r.topic]));

    /* ---------- founder anchors ---------- */
    // anchor(E) = incoming entity sets of E's create_new_event provenance.
    // NULL sets (pre-0044 provenance) or a missing create row → unknown.
    const anchors = deriveAnchors(winners);
    const creates = new Map<string, (typeof winners)[0]>();
    for (const w of winners) {
      if (w.edge.decision === "create") creates.set(w.eventId, w);
    }

    /* ---------- ordered winning merges per event + observed context ---- */
    const mergesByEvent = new Map<string, (typeof winners)[0][]>();
    for (const w of winners) {
      if (w.edge.decision !== "merge") continue;
      const list = mergesByEvent.get(w.eventId) ?? [];
      list.push(w);
      mergesByEvent.set(w.eventId, list);
    }
    // canonical decision clock: resolver_decisions.created_at, id
    const decTime = (w: (typeof winners)[0]) =>
      decById.get(w.decisionId)?.created_at ?? w.edge.created_at;
    const ordinals = new Map<string, number>();
    const contextBefore = new Map<
      string,
      { entities: string[]; core: string[] }
    >();
    for (const [eventId, list] of mergesByEvent) {
      list.sort((a, b) => {
        const ta = decTime(a),
          tb = decTime(b);
        return ta === tb
          ? a.decisionId.localeCompare(b.decisionId)
          : ta < tb
            ? -1
            : 1;
      });
      // observed context mirrors production accumulation:
      //   nextFull = candFull ∪ incFull
      //   nextCore = incCore ∪ (prevCore || prevFull)
      const anchor = anchors.get(eventId);
      let obsFull = anchor?.entities ? [...anchor.entities] : null;
      let obsCore = anchor?.core
        ? anchor.core.length
          ? [...anchor.core]
          : [...(anchor.entities ?? [])]
        : null;
      list.forEach((w, i) => {
        ordinals.set(w.decisionId, i + 1);
        if (obsFull !== null)
          contextBefore.set(w.decisionId, {
            entities: sorted(obsFull),
            core: sorted(obsCore!),
          });
        const incFull = arr(w.edge.incoming_entities);
        const incCore = arr(w.edge.incoming_core_entities);
        if (obsFull === null || incFull === null || incCore === null) {
          obsFull = null; // continuity broken — stays unknown forever
          obsCore = null;
          return;
        }
        const nextFull = new Set([...obsFull, ...incFull]);
        const nextCore = new Set([
          ...(obsCore!.length ? obsCore! : obsFull),
          ...incCore,
        ]);
        obsFull = [...nextFull];
        obsCore = [...nextCore];
      });
    }

    /* ---------- incoming sets by cluster (non-winner link) ---------- */
    const clusterIncoming = new Map<
      string,
      {
        entities: string[] | null;
        core: string[] | null;
        thresholds: ResolverThresholds | null;
      }
    >();
    for (const w of winners) {
      const c = w.edge.incoming_cluster;
      if (!c || clusterIncoming.has(c)) continue;
      clusterIncoming.set(c, {
        entities: arr(w.edge.incoming_entities),
        core: arr(w.edge.incoming_core_entities),
        thresholds:
          (w.edge.explanation?.thresholds as ResolverThresholds | undefined) ??
          null,
      });
    }

    /* ---------- reconstruct candidate state for non-winners ---------- */
    // candidate entity sets at time T = anchor ∪ incoming of the
    // candidate event's winning merges that preceded T (canonical order)
    const reconstruct = (eventId: string, at: string) => {
      const anchor = anchors.get(eventId);
      if (!anchor || anchor.entities === null) return null;
      const merges = mergesByEvent.get(eventId) ?? [];
      let full = new Set(anchor.entities);
      let core = new Set(
        anchor.core && anchor.core.length ? anchor.core : anchor.entities,
      );
      for (const m of merges) {
        const t = decTime(m);
        if (t >= at) break;
        const incF = arr(m.edge.incoming_entities);
        const incC = arr(m.edge.incoming_core_entities);
        if (incF === null || incC === null) return null;
        incF.forEach((e) => full.add(e));
        incC.forEach((e) => core.add(e));
      }
      return { entities: sorted([...full]), core: sorted([...core]) };
    };

    /* ---------- emit records ---------- */
    const records: ReplayInput[] = [];

    for (const w of winners.sort((a, b) => {
      const ta = decTime(a),
        tb = decTime(b);
      return ta === tb
        ? a.decisionId.localeCompare(b.decisionId)
        : ta < tb
          ? -1
          : 1;
    })) {
      const d = decById.get(w.decisionId);
      const e = w.edge;
      const anchor = anchors.get(e.event_id);
      const expl = (e.explanation ?? {}) as Json & {
        thresholds?: ResolverThresholds;
      };
      const { thresholds, ...features } = expl;
      records.push({
        resolverDecisionId: w.decisionId,
        incomingCluster: e.incoming_cluster,
        candidateEventId: e.candidate_event_id,
        chosenEventId: d?.chosen_event_id ?? e.event_id,
        winnerPair: true,
        decisionAt: decTime(w),
        decisionOrdinal:
          e.decision === "merge" ? (ordinals.get(w.decisionId) ?? null) : 0,
        actualDecision: e.decision,
        actualPath: e.path,
        actualScore: e.score,
        features: Object.keys(features).length ? features : null,
        thresholds: thresholds ?? null,
        incomingEntities: arr(e.incoming_entities),
        incomingCoreEntities: arr(e.incoming_core_entities),
        candidateEntitiesBefore: arr(e.candidate_entities_before),
        candidateCoreEntitiesBefore: arr(e.candidate_core_entities_before),
        candidateSignatureHashBefore: e.candidate_signature_hash_before,
        reconstructedCandidateEntities:
          contextBefore.get(w.decisionId)?.entities ?? null,
        reconstructedCandidateCoreEntities:
          contextBefore.get(w.decisionId)?.core ?? null,
        anchorEntities: anchor?.entities ?? null,
        anchorCoreEntities: anchor?.core ?? null,
        topic: topics.get(e.event_id) ?? null,
        crossLanguage: e.cross_language,
        semanticAvailable: d?.semantic_available ?? false,
        attachedEvidenceVersionIds: w.evidenceVersionIds,
      });
      if (!w.invariantOk)
        records[records.length - 1].groupInvariantViolation = true;
    }

    for (const d of nonWinners) {
      const link = d.incoming_cluster
        ? clusterIncoming.get(d.incoming_cluster)
        : undefined;
      const cand = d.candidate_event_id;
      const anchor = cand ? anchors.get(cand) : undefined;
      const recon = cand ? reconstruct(cand, d.created_at) : null;
      const features =
        d.features && Object.keys(d.features).length > 0 ? d.features : null;
      records.push({
        resolverDecisionId: d.id,
        incomingCluster: d.incoming_cluster,
        candidateEventId: d.candidate_event_id,
        chosenEventId: d.chosen_event_id,
        winnerPair: false,
        decisionAt: d.created_at,
        decisionOrdinal: null,
        actualDecision: d.decision,
        actualPath: d.path,
        actualScore: d.score,
        features: features as ReplayInput["features"],
        thresholds: link?.thresholds ?? null,
        incomingEntities: link ? link.entities : null,
        incomingCoreEntities: link ? link.core : null,
        candidateEntitiesBefore: null,
        candidateCoreEntitiesBefore: null,
        candidateSignatureHashBefore: null,
        reconstructedCandidateEntities: recon?.entities ?? null,
        reconstructedCandidateCoreEntities: recon?.core ?? null,
        anchorEntities: anchor?.entities ?? null,
        anchorCoreEntities: anchor?.core ?? null,
        topic:
          (d.candidate_event_id ? topics.get(d.candidate_event_id) : null) ??
          null,
        crossLanguage:
          d.features && typeof d.features.sameLanguage === "boolean"
            ? !d.features.sameLanguage
            : null,
        semanticAvailable: d.semantic_available,
        attachedEvidenceVersionIds: [],
      });
      if (!link && d.incoming_cluster)
        records[records.length - 1].incomingClusterNotLinkable = true;
    }

    records.sort((a, b) =>
      a.decisionAt === b.decisionAt
        ? a.resolverDecisionId.localeCompare(b.resolverDecisionId)
        : a.decisionAt < b.decisionAt
          ? -1
          : 1,
    );

    /* ---------- semantic corpus hash ---------- */
    const corpusHash = replayCorpusHash(
      records as unknown as Record<string, unknown>[],
    );

    const corpus = {
      schemaVersion: "resolver-replay-corpus/v1",
      generatedAt: new Date().toISOString(),
      policy: "founding_immutable_entity_anchor_v1",
      sourceBoundary: {
        provenanceEraStart: era,
        minDecisionAt: records[0]?.decisionAt ?? null,
        maxDecisionAt: records[records.length - 1]?.decisionAt ?? null,
      },
      counts: {
        decisions: records.length,
        winnerDecisions: winners.length,
        creates: creates.size,
        merges: winners.length - creates.size,
        nonWinners: nonWinners.length,
        eventsWithAnchor: [...anchors.values()].filter(
          (a) => a.entities !== null,
        ).length,
        groupInvariantFailures,
      },
      records,
      corpusHash,
    };

    const fs = await import("node:fs");
    fs.writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
    console.log(
      `decisions=${records.length} winners=${winners.length} (creates=${creates.size} merges=${winners.length - creates.size}) ` +
        `nonWinners=${nonWinners.length} anchoredEvents=${corpus.counts.eventsWithAnchor} ` +
        `groupInvariantFailures=${groupInvariantFailures} corpusHash=${corpusHash}`,
    );
    console.log(`→ ${OUT}`);
  } finally {
    client.release();
    await db.end();
  }
}

await main();
