/**
 * Historical evidence_entities backfill — runs the SAME deterministic
 * assertion rules as the live writer (evidenceEntityAssertions) over
 * stored EvidenceVersions, in batches, idempotently.
 *
 *   npx tsx scripts/backfill-evidence-entities.mts [--all] [--batch N]
 *                                                    [--limit N] [--db URL]
 *
 * Defaults: DATABASE_URL from .env.local; only each document's CURRENT
 * version is processed (the live state). --all also covers superseded
 * versions. Rerunning inserts zero duplicates — versions that already
 * carry evidence_entities rows are skipped up front and every insert is
 * ON CONFLICT-safe. EvidenceVersion history is never modified.
 */

import { readFileSync } from "node:fs";
import pg from "pg";
import type { PoolClient } from "pg";
import { evidenceEntityAssertions } from "../lib/db/writer";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

const URL =
  opt("--db", "") ||
  process.env.TARGET_DATABASE_URL ||
  process.env.DATABASE_URL;
if (!URL) throw new Error("no database url (DATABASE_URL or --db)");
const ALL = flag("--all");
const BATCH = Number(opt("--batch", "200"));
const LIMIT = Number(opt("--limit", "0")) || null;

const client = new pg.Client({ connectionString: URL });
await client.connect();
const qc = client as unknown as PoolClient;

interface VersionRow {
  id: string;
  title: string;
  summary: string | null;
  structured_data: Record<string, unknown> | null;
  source_name: string;
  source_kind: string;
  canonical_url: string;
}

const metrics = {
  versionsScanned: 0,
  versionsWithEntities: 0,
  rowsInserted: 0,
  subject: 0,
  mentioned: 0,
  issuer: 0,
  unresolvedIssuers: 0,
  failures: 0,
  batches: 0,
};

let lastId = "00000000-0000-0000-0000-000000000000";
for (;;) {
  const { rows: versions } = await client.query<VersionRow>(
    `SELECT v.id, v.title, v.summary, v.structured_data,
            s.name AS source_name, s.kind::text AS source_kind,
            d.canonical_url
     FROM evidence_versions v
     JOIN evidence_documents d ON d.id = v.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE v.id > $1
       ${ALL ? "" : "AND d.current_version_id = v.id"}
       AND NOT EXISTS (
         SELECT 1 FROM evidence_entities ee
         WHERE ee.evidence_version_id = v.id
       )
     ORDER BY v.id
     LIMIT $2`,
    [lastId, BATCH],
  );
  if (!versions.length) break;

  for (const v of versions) {
    metrics.versionsScanned++;
    lastId = v.id;
    try {
      const { rows, unresolvedIssuers } = await evidenceEntityAssertions(qc, {
        title: v.title,
        summary: v.summary,
        structuredData: v.structured_data ?? undefined,
        sourceName: v.source_name,
        sourceUrl: v.canonical_url,
        isPrimary: v.source_kind === "primary",
      });
      metrics.unresolvedIssuers += unresolvedIssuers;
      if (!rows.length) continue;
      metrics.versionsWithEntities++;
      const res = await client.query(
        `INSERT INTO evidence_entities
           (evidence_version_id, entity_id, mention_role, in_title, method, matched_slug)
         VALUES ${rows
           .map(
             (_, i) =>
               `($1, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6})`,
           )
           .join(",")}
         ON CONFLICT DO NOTHING`,
        [
          v.id,
          ...rows.flatMap(
            (r) => [r.id, r.role, r.title, r.method, r.slug ?? null] as const,
          ),
        ],
      );
      metrics.rowsInserted += res.rowCount ?? rows.length;
      for (const r of rows) {
        if (r.role === "subject") metrics.subject++;
        else if (r.role === "issuer") metrics.issuer++;
        else metrics.mentioned++;
      }
    } catch (e) {
      metrics.failures++;
      console.error(`version ${v.id}: ${(e as Error).message}`);
    }
    if (LIMIT && metrics.versionsScanned >= LIMIT) break;
  }
  metrics.batches++;
  if (versions.length < BATCH || (LIMIT && metrics.versionsScanned >= LIMIT))
    break;
}

await client.end();
console.log(JSON.stringify(metrics, null, 2));
