/**
 * R7.1d.3a.1 — standingEvidenceByClaim is THE canonical claim↔doc
 * provenance accessor. Claim evidence is version-scoped and never
 * carried forward: a superseded claim_version keeps its evidence while
 * a synthesized/converged current version often has none. Reading
 * evidence through current_version_id alone silently loses provenance —
 * that was the attachment-corpus bug this accessor fixes.
 *
 * Invariants under test:
 *   - evidence on an OLDER version backs the claim even when the current
 *     version carries no claim_evidence rows
 *   - only docs behind latest-per-origin votes on the STANDING position
 *     are returned — a voter whose latest assertion moved elsewhere is
 *     excluded
 *   - voter identity is the lineage-root source: a syndicated reprint
 *     collapses into its origin's vote (latest by evidence time wins)
 *   - protected states keep the current position even when live votes
 *     stand elsewhere (then no doc backs it → standing is empty)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import { standingEvidenceByClaim } from "../lib/db/adjudicate";
import { posKey } from "../lib/db/positions";

function setupDb() {
  const db = newDb();
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n")
    .replace(
      /CREATE OR REPLACE FUNCTION uuid_v7[\s\S]*?LANGUAGE plpgsql VOLATILE;/,
      "",
    )
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/g, "");
  db.public.registerFunction({
    name: "uuid_v7",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  db.public.none(sql);
  const pg = db.adapters.createPg();
  injectPool(new pg.Pool() as unknown as Pool);
}

const T0 = Date.parse("2026-05-10T08:00:00Z");
const at = (h: number) => new Date(T0 + h * 3600_000).toISOString();

async function mkEvent() {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO events (id, topic, status, first_seen_at, last_seen_at)
     VALUES ($1, 'world', 'emerging', now(), now())`,
    [id],
  );
  return id;
}

async function mkSource(name: string, kind = "publisher") {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO sources (id, name, kind) VALUES ($1, $2, $3::source_kind)`,
    [id, name, kind],
  );
  return id;
}

async function mkDoc(
  sourceId: string,
  publishedAt: string,
  relation: "original" | "syndicated" = "original",
  parentDocId: string | null = null,
) {
  const docId = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_documents
       (id, source_id, canonical_url, first_seen_at, last_seen_at,
        discovered_via)
     VALUES ($1, $2, $3, $4, $4, 'rss')`,
    [docId, sourceId, `https://x.vn/${docId}`, publishedAt],
  );
  const evId = randomUUID();
  await getPool().query(
    `INSERT INTO evidence_versions
       (id, document_id, version_no, title, content_hash, observed_at)
     VALUES ($1, $2, 1, 't', $3, $4)`,
    [evId, docId, `h-${docId}`, publishedAt],
  );
  await getPool().query(
    `INSERT INTO evidence_lineage
       (child_document_id, version_no, parent_document_id,
        origin_document_id, relation, confidence, method)
     VALUES ($1, 1, $2, $3, $4::lineage_relation, 1, 'rule')`,
    [
      docId,
      parentDocId,
      relation === "original" ? null : parentDocId,
      relation,
    ],
  );
  return { docId, evId };
}

async function mkClaim(eventId: string) {
  const claimId = randomUUID();
  await getPool().query(
    `INSERT INTO claims
       (id, event_id, claim_key, predicate, claim_type,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'money_usd', 'fact', now(), now())`,
    [claimId, eventId, `k-${claimId}`],
  );
  return claimId;
}

/** Append a claim_version and make it current. */
async function mkClaimVersion(
  claimId: string,
  versionNo: number,
  value: unknown,
  state = "reported",
) {
  const versionId = randomUUID();
  await getPool().query(
    `INSERT INTO claim_versions
       (id, claim_id, version_no, value_type, value, unit,
        state, observed_at, change_type, content_hash)
     VALUES ($1, $2, $3, 'number', $4::jsonb, 'usd',
             $5::claim_state, now(), 'initial', $6)`,
    [
      versionId,
      claimId,
      versionNo,
      JSON.stringify(value),
      state,
      `ch-${versionId}`,
    ],
  );
  await getPool().query(
    `UPDATE claims SET current_version_id = $1 WHERE id = $2`,
    [versionId, claimId],
  );
  return versionId;
}

async function linkEvidence(
  claimVersionId: string,
  evId: string,
  strength = "secondary",
) {
  await getPool().query(
    `INSERT INTO claim_evidence
       (claim_version_id, evidence_version_id, stance,
        evidence_strength, extraction_method)
     VALUES ($1, $2, 'supports', $3::evidence_strength, 'rule')`,
    [claimVersionId, evId, strength],
  );
}

test("evidence on a superseded version backs the claim when the current version has none", async () => {
  setupDb();
  const eventId = await mkEvent();
  const src = await mkSource("wire-a");
  const { docId, evId } = await mkDoc(src, at(1));

  const claimId = await mkClaim(eventId);
  // v1 extracted with evidence; v2 is a synthesized rewrite of the SAME
  // position — convergence created it, so no claim_evidence rows
  const v1 = await mkClaimVersion(claimId, 1, 5);
  await linkEvidence(v1, evId, "direct");
  await mkClaimVersion(claimId, 2, 5);

  const out = await standingEvidenceByClaim(getPool(), [claimId]);
  const se = out.get(claimId);
  assert.ok(se, "claim must be present");
  assert.equal(se.standingPos, posKey(5, "usd"));
  assert.deepEqual(
    se.standing.map((r) => r.evidenceVersionId).sort(),
    [evId].sort(),
    "the standing doc must be recoverable from the superseded version",
  );
  assert.deepEqual(se.allDocIds, [docId]);
});

test("only latest-per-origin votes on the standing position return docs", async () => {
  setupDb();
  const eventId = await mkEvent();
  const srcA = await mkSource("src-a");
  const srcB = await mkSource("src-b");
  const docA = await mkDoc(srcA, at(1));
  const docB = await mkDoc(srcB, at(2));

  const claimId = await mkClaim(eventId);
  const v1 = await mkClaimVersion(claimId, 1, 5); // srcA asserts 5
  await linkEvidence(v1, docA.evId);
  const v2 = await mkClaimVersion(claimId, 2, 7); // srcB asserts 7, direct
  await linkEvidence(v2, docB.evId, "direct");
  await mkClaimVersion(claimId, 3, 7); // current converged on 7

  const se = (await standingEvidenceByClaim(getPool(), [claimId])).get(
    claimId,
  )!;
  assert.equal(se.standingPos, posKey(7, "usd"), "primary doc wins the rank");
  assert.deepEqual(
    se.standing.map((r) => r.docId),
    [docB.docId],
    "srcA's vote stands on a losing position — its doc must not leak in",
  );
  assert.deepEqual(
    se.allDocIds.sort(),
    [docA.docId, docB.docId].sort(),
    "frontier still spans every touched doc",
  );
});

test("voter is the lineage-root source — syndicated reprint collapses into the origin vote", async () => {
  setupDb();
  const eventId = await mkEvent();
  const origin = await mkSource("origin-wire");
  const republisher = await mkSource("republisher");
  const root = await mkDoc(origin, at(1));
  // a reprint whose lineage root resolves to origin-wire
  const reprint = await mkDoc(republisher, at(3), "syndicated", root.docId);

  const claimId = await mkClaim(eventId);
  const v1 = await mkClaimVersion(claimId, 1, 5);
  await linkEvidence(v1, root.evId);
  await linkEvidence(v1, reprint.evId);

  const se = (await standingEvidenceByClaim(getPool(), [claimId])).get(
    claimId,
  )!;
  // both docs resolve to the SAME voter; the later evidence-time vote wins
  assert.deepEqual(
    se.standing.map((r) => r.evidenceVersionId),
    [reprint.evId],
    "one voter → one latest vote; the reprint never adds a second origin",
  );
});

test("accessor never escapes to the global pool when a client is passed", async () => {
  /* audit R7.1d.3a.2: lineage reads inside resolveOriginSources used to
   * call getPool() — a REPEATABLE READ corpus snapshot would silently
   * read lineage outside the transaction. Fixture lives on db1; the
   * global pool is swapped to an EMPTY db2 — any leaked getPool() call
   * throws on missing tables instead of returning db1 rows. */
  setupDb();
  const populated = getPool();
  const eventId = await mkEvent();
  const src = await mkSource("wire-iso");
  const { evId } = await mkDoc(src, at(1));
  const claimId = await mkClaim(eventId);
  const v1 = await mkClaimVersion(claimId, 1, 5);
  await linkEvidence(v1, evId, "direct");

  // swap the global pool to a bare db — leaked reads must explode
  const empty = newDb();
  injectPool(new (empty.adapters.createPg().Pool)() as unknown as Pool);

  const client = await populated.connect();
  try {
    const se = (await standingEvidenceByClaim(client, [claimId])).get(claimId)!;
    assert.equal(se.standing.length, 1);
    assert.equal(se.standing[0].evidenceVersionId, evId);
  } finally {
    client.release();
  }
});

test("protected state keeps the current position — votes standing elsewhere back nothing", async () => {
  setupDb();
  const eventId = await mkEvent();
  const src = await mkSource("src-c");
  const doc = await mkDoc(src, at(1));

  const claimId = await mkClaim(eventId);
  const v1 = await mkClaimVersion(claimId, 1, 5);
  await linkEvidence(v1, doc.evId);
  // human/curation lands the claim on 'confirmed' at a DIFFERENT position
  await mkClaimVersion(claimId, 2, 9, "confirmed");

  const se = (await standingEvidenceByClaim(getPool(), [claimId])).get(
    claimId,
  )!;
  assert.equal(
    se.standingPos,
    posKey(9, "usd"),
    "protected state pins position",
  );
  assert.deepEqual(
    se.standing,
    [],
    "no live vote stands on the confirmed position → no standing doc",
  );
});
