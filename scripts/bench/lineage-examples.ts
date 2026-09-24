/**
 * Produces the three deliverable hardening scenarios against an in-memory
 * pg database:
 *   1) late Reuters parent arrives after a local copy (unknown v1 -> v2)
 *   2) Fed -> Reuters -> local rewrite with parent re-rooting
 *   3) primary source + ambiguous publisher (unresolved never inflates)
 * Prints lineage VERSIONS, the effective graph, confirmedIndependentOrigins,
 * unresolvedOrigins, primaryOrigins and confidence.state as EventView
 * exposes them.
 * Run: npx tsx scripts/bench/lineage-examples.ts
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DataType, newDb } from "pg-mem";
import type { Pool } from "pg";
import { getEventView } from "../../lib/db/read";
import { getPool, injectPool } from "../../lib/db/pool";
import { persistCluster } from "../../lib/db/writer";
import { extractClaims } from "../../lib/db/extract";
import { resolveOrigins } from "../../lib/lineage";
import type { Article, StoryCluster } from "../../lib/model";

function setupDb() {
  const db = newDb();
  const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));
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

function art(over: Partial<Article>): Article {
  return {
    id: over.id ?? randomUUID(),
    title: over.title ?? "title",
    summary: over.summary ?? "",
    url: over.url ?? `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: over.publishedAt ?? new Date().toISOString(),
    source: over.source ?? "VnExpress",
    topic: over.topic ?? "world",
    headline: false,
    appearances: [],
    language: over.language ?? "vi",
    ingest: over.ingest,
  };
}

const cluster = (articles: Article[]): StoryCluster => ({
  id: `c-${randomUUID().slice(0, 8)}`,
  title: articles[0].title,
  summary: "",
  leadArticle: articles[0],
  articles,
  sources: articles.map((a) => ({ name: a.source, url: a.url })),
  topic: "world",
  scope: "world",
  significanceScore: 50,
  publishedAt: articles[0].publishedAt,
});

const WIRE_TITLE = "Fed giữ lãi suất ở mức 4.25% trong tháng 9";
const WIRE_SUM =
  "Ngân hàng dự trữ liên bang quyết định giữ nguyên lãi suất cơ bản ở mức 4.25% trong cuộc họp tháng 9. Chủ tịch Fed cho biết lạm phát vẫn còn cao so với mục tiêu 2% và cần thêm dữ liệu trước khi cân nhắc nới lỏng.";

async function printReport(label: string, eventId: string) {
  const pool = getPool();
  const view = await getEventView(eventId);
  const { rows: versions } = await pool.query<{
    child: string;
    parent: string | null;
    relation: string;
    version_no: number;
    classifier_version: string;
  }>(
    `SELECT cs.name AS child, ps.name AS parent, l.relation,
            l.version_no, l.classifier_version
       FROM evidence_lineage l
       JOIN evidence_documents cd ON cd.id = l.child_document_id
       JOIN sources cs ON cs.id = cd.source_id
       LEFT JOIN evidence_documents pd ON pd.id = l.parent_document_id
       LEFT JOIN sources ps ON ps.id = pd.source_id
      WHERE l.child_document_id IN (
        SELECT ev.document_id FROM event_evidence ee
        JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
        WHERE ee.event_id = $1)
      ORDER BY cs.name, l.version_no`,
    [eventId],
  );
  // effective roots resolved dynamically from the LATEST assertion map —
  // the stored origin_document_id cache is never consulted. Rows arrive
  // ordered by version_no so the last write per child wins; parent links
  // are already rendered as source names.
  const latest = new Map<
    string,
    { parentDocumentId: string | null; relation: string }
  >();
  for (const v of versions)
    latest.set(v.child, {
      parentDocumentId: v.parent,
      relation: v.relation,
    });
  const roots = resolveOrigins(latest as never) as unknown as Map<
    string,
    string
  >;

  console.log(`\n═══ ${label} ═══`);
  console.log(`eventId: ${eventId}`);
  console.log("lineage versions (append-only):");
  for (const v of versions)
    console.log(
      `  v${v.version_no} [${v.classifier_version}] ` +
        `${v.child.slice(0, 26).padEnd(26)} ${v.relation.padEnd(20)}` +
        (v.parent ? ` → ${v.parent.slice(0, 30)}` : " (no parent)"),
    );
  console.log("effective graph (latest assertions, dynamic root):");
  for (const [child, cur] of latest) {
    const root = roots.get(child);
    console.log(
      `  ${child.slice(0, 26).padEnd(26)} latest=${cur.relation.padEnd(20)}` +
        ` root=${root === child || !root ? "self" : root}`,
    );
  }
  const c = view?.confidence;
  console.log(`confirmedIndependentOrigins: ${c?.confirmedIndependentOrigins}`);
  console.log(`unresolvedOrigins:           ${c?.unresolvedOrigins}`);
  console.log(`primaryOrigins:              ${c?.primaryOrigins}`);
  console.log(`rawSourceCount:              ${c?.rawSourceCount}`);
  console.log(`derivedDocuments:            ${c?.derivedDocuments}`);
  console.log(`lineageCoverage:             ${c?.lineageCoverage}`);
  console.log(`confidence.state:            ${c?.state}`);
}

async function main() {
  const t0 = Date.parse("2026-09-24T08:00:00Z");

  // ── 1. Late Reuters parent appears after local copy ─────────────────
  setupDb();
  const c1 = cluster([
    art({
      source: "LocalSite",
      title: WIRE_TITLE,
      summary: WIRE_SUM,
      url: "https://localsite.vn/fed-rate",
      publishedAt: new Date(t0 + 900_000).toISOString(), // observed 08:15
      language: "vi",
    }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  await printReport("1) LATE REUTERS PARENT — after cycle 1", r1.eventId);
  const c2 = cluster([
    art({
      source: "Reuters",
      title: WIRE_TITLE,
      summary: WIRE_SUM,
      url: "https://reuters.com/fed-rate",
      publishedAt: new Date(t0).toISOString(), // published 08:00, seen later
      language: "vi",
    }),
  ]);
  await persistCluster(c2, extractClaims(c2));
  await printReport("1) LATE REUTERS PARENT — after wire arrives", r1.eventId);

  // ── 2. Fed → Reuters → local rewrite with parent re-rooting ─────────
  setupDb();
  // cycle 1: Reuters cites a statement we can't see yet; Tuổi Trẻ copies
  // Reuters verbatim → Tuổi Trẻ → Reuters, Reuters unresolved
  const s1 = cluster([
    art({
      source: "Reuters",
      title: WIRE_TITLE,
      summary: WIRE_SUM + " The Federal Reserve said in a statement.",
      url: "https://reuters.com/fed-rate",
      publishedAt: new Date(t0).toISOString(),
      language: "vi",
    }),
    art({
      source: "Tuổi Trẻ",
      title: WIRE_TITLE,
      summary: WIRE_SUM,
      url: "https://tuoitre.vn/fed-copy",
      publishedAt: new Date(t0 + 1_800_000).toISOString(),
      language: "vi",
    }),
  ]);
  const r2 = await persistCluster(s1, extractClaims(s1));
  await printReport(
    "2) FED → REUTERS → LOCAL — before Fed arrives",
    r2.eventId,
  );
  // cycle 2: the FOMC statement itself shows up; Reuters re-points to the
  // primary doc and Tuổi Trẻ re-roots through it without a new assertion
  const s2 = cluster([
    art({
      source: "Federal Reserve",
      title: "Federal Reserve issues FOMC statement — rate held at 4.25%",
      summary:
        "The Committee decided to maintain the target range for the federal funds rate at 4.25 percent. Inflation remains somewhat elevated.",
      url: "https://federalreserve.gov/fomc-statement",
      publishedAt: new Date(t0 - 3_600_000).toISOString(),
      language: "en",
      ingest: {
        sourceKind: "primary",
        discoveredVia: "official_rss",
        documentType: "press_release",
      },
    }),
  ]);
  await persistCluster(s2, extractClaims(s2));
  await printReport("2) FED → REUTERS → LOCAL — after Fed arrives", r2.eventId);

  // ── 3. Primary source + ambiguous publisher ─────────────────────────
  setupDb();
  const s3 = cluster([
    art({
      source: "Federal Reserve",
      title: "Federal Reserve keeps federal funds rate at 4.25 percent",
      summary:
        "The Committee maintained the target range at 4.25 percent, the Federal Reserve said in a statement.",
      url: "https://federalreserve.gov/fomc-3",
      publishedAt: new Date(t0).toISOString(),
      language: "en",
      ingest: {
        sourceKind: "primary",
        discoveredVia: "official_rss",
        documentType: "press_release",
      },
    }),
    art({
      // gray-zone wording: related enough to suspect, not enough to
      // derive — must remain unresolved, never a second origin
      source: "VnEconomy",
      title: "Federal Reserve keeps rate at 4.25% — markets react",
      summary: "Markets moved after the Federal Reserve decision.",
      url: "https://vneconomy.vn/fed-markets",
      publishedAt: new Date(t0 + 7_200_000).toISOString(),
      language: "en",
    }),
  ]);
  const r3 = await persistCluster(s3, extractClaims(s3));
  await printReport("3) PRIMARY + AMBIGUOUS PUBLISHER", r3.eventId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
