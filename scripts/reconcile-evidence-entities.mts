/**
 * Identity V1.2 reconciliation — rebuilds the DERIVED gazetteer
 * projection (evidence_entities rows with method='gazetteer') so it
 * matches what the current deterministic extraction produces from the
 * stored EvidenceVersion text.
 *
 *   npx tsx scripts/reconcile-evidence-entities.mts            # dry-run → artifact
 *   npx tsx scripts/reconcile-evidence-entities.mts --apply    # mutate
 *
 *   options: --all  --db URL  --limit N  --out bench/entity-reconciliation.json
 *
 * Scope: every EvidenceVersion that carries a gazetteer row on one of
 * the ontology-split families (old→new mapping listed in FAMILY below).
 * For each affected version the script re-runs the SAME
 * evidenceEntityAssertions() the live writer uses — no LLM, no guessing.
 *
 * Only method='gazetteer' rows may be removed/rebuilt — the projection,
 * not history. structured_cik / structured_issuer / structured_coquan /
 * source_publisher rows are provenance assertions and are never
 * touched; EvidenceVersion itself is immutable.
 *
 * Rerunning produces zero adds/deletes (idempotent).
 */

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import type { PoolClient } from "pg";
import { evidenceEntityAssertions } from "../lib/db/writer";
import {
  applyEvidencePlan,
  planEvidenceReconciliation,
} from "../lib/db/reconcile";
import { canonicalKeyForSlug } from "../lib/entities";

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
  process.env.PROD_URL ||
  `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(process.env.SUPABASE_DB_PASS!)}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const APPLY = flag("--apply");
const ALL = flag("--all");
const LIMIT = Number(opt("--limit", "0")) || null;
const OUT = opt("--out", "bench/entity-reconciliation.json");

/* old→new split families — every canonical entity whose assertion could
 * have been minted under the V1 ontology (or blindly re-pointed by 0014) */
const FAMILY: Record<string, string[]> = {
  google: [
    "company:alphabet",
    "brand:google",
    "brand:deepmind",
    "company:google_llc",
  ],
  openai: ["company:openai", "brand:chatgpt"],
  anthropic: ["company:anthropic", "brand:claude"],
  spacex: ["company:spacex", "brand:starlink", "brand:falcon"],
  meta: ["company:meta_platforms", "brand:facebook"],
  bytedance: ["company:bytedance", "brand:tiktok"],
  vinfast: ["company:vinfast", "brand:green_sm", "company:gsm"],
};
const FAMILY_KEYS = [...new Set(Object.values(FAMILY).flat())];

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
interface StoredRow {
  id: string;
  entity_id: string;
  canonical_key: string;
  entity_type: string;
  mention_role: string;
  in_title: boolean;
  method: string;
  matched_slug: string | null;
}

const { rows: idRows } = await client.query<{ id: string }>(
  `SELECT id FROM entities WHERE canonical_key = ANY($1)`,
  [FAMILY_KEYS],
);
const familyIds = idRows.map((r) => r.id);

const keyOf = new Map<string, string>();
const typeOf = new Map<string, string>();
{
  const { rows } = await client.query<{
    id: string;
    canonical_key: string;
    entity_type: string;
  }>(`SELECT id, canonical_key, entity_type FROM entities`);
  for (const r of rows) {
    keyOf.set(r.id, r.canonical_key);
    typeOf.set(r.id, r.entity_type);
  }
}

/* affected versions: any gazetteer assertion attached to a family
 * entity — or, with --all, every version carrying the derived
 * projection (full-corpus slug/provenance backfill) */
const { rows: affected } = ALL
  ? await client.query<{ id: string }>(
      `SELECT DISTINCT v.id
       FROM evidence_versions v
       JOIN evidence_entities ee ON ee.evidence_version_id = v.id
       WHERE ee.method = 'gazetteer'
       ORDER BY v.id`,
    )
  : await client.query<{ id: string }>(
      `SELECT DISTINCT v.id
       FROM evidence_versions v
       JOIN evidence_entities ee ON ee.evidence_version_id = v.id
       WHERE ee.method = 'gazetteer' AND ee.entity_id = ANY($1)
       ORDER BY v.id`,
      [familyIds],
    );

const metrics = {
  versionsScanned: affected.length,
  affectedVersions: 0,
  staleRemoved: 0,
  missingAdded: 0,
  unchanged: 0,
  companyToBrand: 0,
  brandToCompany: 0,
  ambiguousVersions: 0,
  structuredRowsUntouched: 0,
  matchedSlugFilled: 0,
  failures: 0,
  applied: APPLY,
};
const report: Record<string, unknown>[] = [];

for (const v of affected) {
  if (LIMIT && metrics.affectedVersions >= LIMIT) break;
  try {
    const ver = (
      await client.query<VersionRow>(
        `SELECT v.id, v.title, v.summary, v.structured_data,
                s.name AS source_name, s.kind::text AS source_kind,
                d.canonical_url
         FROM evidence_versions v
         JOIN evidence_documents d ON d.id = v.document_id
         JOIN sources s ON s.id = d.source_id
         WHERE v.id = $1`,
        [v.id],
      )
    ).rows[0];
    const stored = (
      await client.query<StoredRow>(
        `SELECT ee.id, ee.entity_id, e.canonical_key, e.entity_type,
                ee.mention_role, ee.in_title, ee.method, ee.matched_slug
         FROM evidence_entities ee JOIN entities e ON e.id = ee.entity_id
         WHERE ee.evidence_version_id = $1`,
        [v.id],
      )
    ).rows;

    metrics.structuredRowsUntouched += stored.filter(
      (r) => r.method !== "gazetteer",
    ).length;

    const { rows: expected, unresolvedIssuers } =
      await evidenceEntityAssertions(qc, {
        title: ver.title,
        summary: ver.summary,
        structuredData: ver.structured_data ?? undefined,
        sourceName: ver.source_name,
        sourceUrl: ver.canonical_url,
        isPrimary: ver.source_kind === "primary",
      });
    if (unresolvedIssuers > 0) metrics.ambiguousVersions++;

    const plan = planEvidenceReconciliation(stored, expected);
    const { stale, missing, unchanged, refresh } = plan;

    // directional corrections: stale company:* entity alongside a missing
    // brand:* (or vice versa) in the same version
    const staleCompany = stale.filter((r) =>
      r.canonical_key.startsWith("company:"),
    );
    const staleBrand = stale.filter((r) =>
      r.canonical_key.startsWith("brand:"),
    );
    const missCompany = missing.filter((r) =>
      (keyOf.get(r.id) ?? "").startsWith("company:"),
    );
    const missBrand = missing.filter((r) =>
      (keyOf.get(r.id) ?? "").startsWith("brand:"),
    );
    metrics.companyToBrand += Math.min(staleCompany.length, missBrand.length);
    metrics.brandToCompany += Math.min(staleBrand.length, missCompany.length);
    metrics.staleRemoved += stale.length;
    metrics.missingAdded += missing.length;
    metrics.unchanged += unchanged;
    metrics.matchedSlugFilled += refresh.length;
    if (stale.length || missing.length) metrics.affectedVersions++;

    if (stale.length || missing.length || refresh.length) {
      report.push({
        version: v.id,
        title: ver.title,
        existing: stored.map(
          (r) => `${r.canonical_key}:${r.mention_role}:${r.method}`,
        ),
        expected: expected.map(
          (r) => `${keyOf.get(r.id) ?? r.id}:${r.role}:${r.method}`,
        ),
        stale: stale.map((r) => `${r.canonical_key}:${r.mention_role}`),
        missing: missing.map((r) => `${keyOf.get(r.id) ?? r.id}:${r.role}`),
      });
    }

    if (!APPLY) continue;
    await client.query("BEGIN; SET TRANSACTION READ WRITE");
    try {
      await applyEvidencePlan(qc, v.id, plan);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } catch (e) {
    metrics.failures++;
    console.error(`version ${v.id}: ${(e as Error).message}`);
  }
}

/* junction drift check (report-only): junction slugs resolve through
 * the gazetteer — a stored entity_id that disagrees is flagged, never
 * silently rewritten here */
const { rows: junction } = await client.query<{
  entity_slug: string;
  entity_id: string;
  n: string;
}>(`SELECT entity_slug, entity_id, count(*)::text AS n
     FROM event_entities WHERE entity_id IS NOT NULL
     GROUP BY 1, 2`);
const junctionDrift: Record<string, unknown>[] = [];
for (const r of junction) {
  const expectedKey = canonicalKeyForSlug(r.entity_slug);
  const storedKey = keyOf.get(r.entity_id) ?? null;
  if (expectedKey && storedKey && expectedKey !== storedKey)
    junctionDrift.push({
      slug: r.entity_slug,
      stored: storedKey,
      expected: expectedKey,
      rows: r.n,
    });
}

const artifact = {
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  metrics,
  junctionDrift,
  versions: report,
};
writeFileSync(OUT, JSON.stringify(artifact, null, 2));
await client.end();
console.log(
  JSON.stringify({ ...metrics, junctionDrift: junctionDrift.length }, null, 2),
);
console.log(`artifact → ${OUT}`);
