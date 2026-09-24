/**
 * Produces the three deliverable example outputs against an in-memory
 * pg database: (1) ten Reuters copies, (2) Reuters+BBC independent,
 * (3) Fed -> Reuters -> local rewrite. Prints rawSources,
 * independentOrigins, primaryOrigins, the lineage graph, and the
 * claim confidence dimensions as EventView exposes them.
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
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/, "");
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

async function lineageGraph(eventId: string) {
  const pool = getPool();
  const { rows } = await pool.query<{
    child: string;
    parent: string | null;
    relation: string;
    confidence: number;
  }>(
    `SELECT cs.name AS child, ps.name AS parent, l.relation, l.confidence
       FROM evidence_lineage l
       JOIN evidence_documents cd ON cd.id = l.child_document_id
       JOIN sources cs ON cs.id = cd.source_id
       LEFT JOIN evidence_documents pd ON pd.id = l.parent_document_id
       LEFT JOIN sources ps ON ps.id = pd.source_id
      WHERE l.child_document_id IN (
        SELECT ev.document_id FROM event_evidence ee
        JOIN evidence_versions ev ON ev.id = ee.evidence_version_id
        WHERE ee.event_id = $1)
      ORDER BY l.detected_at`,
    [eventId],
  );
  return rows;
}

async function report(label: string, c: StoryCluster) {
  const r = await persistCluster(c, extractClaims(c));
  const view = await getEventView(r.eventId);
  const graph = await lineageGraph(r.eventId);
  console.log(`\n═══ ${label} ═══`);
  console.log(`eventId: ${r.eventId}`);
  console.log(`rawSources:          ${view?.confidence.rawSourceCount}`);
  console.log(`independentOrigins:  ${view?.confidence.independentOrigins}`);
  console.log(`primaryOrigins:      ${view?.confidence.primaryOrigins}`);
  console.log(`syndicatedSources:   ${view?.confidence.syndicatedSources}`);
  console.log(`unknownOrigins:      ${view?.confidence.unknownOrigins}`);
  console.log(`lineageCoverage:     ${view?.confidence.lineageCoverage}`);
  console.log(`directEvidence:      ${view?.confidence.directEvidenceCount}`);
  console.log(`contradictions:      ${view?.confidence.contradictions}`);
  console.log(`confidence state:    ${view?.confidence.state}`);
  console.log("lineage graph:");
  for (const g of graph)
    console.log(
      `  ${g.relation.padEnd(20)} ${g.child.slice(0, 42)}` +
        (g.parent ? `  <- ${g.parent.slice(0, 40)}` : "  (root)"),
    );
  console.log("claim confidence dims:");
  for (const cl of view?.claims ?? [])
    console.log(
      `  ${cl.predicate}=${JSON.stringify(cl.value)} state=${cl.state} ` +
        `evidence=${cl.evidenceCount} primaryEvidence=${cl.primaryEvidenceCount}`,
    );
  console.log(`changes: ${r.changes.length ? r.changes.join(" | ") : "(none)"}`);
}

async function main() {
  const t0 = Date.parse("2026-09-24T08:00:00Z");

  // ── 1. Ten Reuters copies ────────────────────────────────────────────
  setupDb();

  // ── 1. Ten Reuters copies ────────────────────────────────────────────
  const copies: Article[] = [
    art({
      source: "Reuters",
      title: WIRE_TITLE,
      summary: WIRE_SUM,
      url: "https://reuters.com/fed-rate",
      publishedAt: new Date(t0).toISOString(),
      language: "vi",
    }),
  ];
  const outlets = [
    "Báo Đầu Tư",
    "CafeF",
    "VietStock",
    "Tinnhanhchungkhoan",
    "Thanh Niên",
    "Lao Động",
    "Báo Mới",
    "VTC News",
    "Dân Trí",
  ];
  outlets.forEach((o, i) =>
    copies.push(
      art({
        source: o,
        title: WIRE_TITLE,
        summary: WIRE_SUM,
        url: `https://copy${i}.vn/fed-rate`,
        publishedAt: new Date(t0 + (i + 1) * 600_000).toISOString(),
        language: "vi",
      }),
    ),
  );
  await report("1) TEN COPIES OF ONE REUTERS WIRE", cluster(copies));

  // ── 2. Reuters + BBC independent ─────────────────────────────────────
  setupDb();
  await report(
    "2) REUTERS + BBC INDEPENDENT",
    cluster([
      art({
        source: "Reuters",
        title: WIRE_TITLE,
        summary: WIRE_SUM,
        url: "https://reuters.com/fed-rate",
        publishedAt: new Date(t0).toISOString(),
        language: "vi",
      }),
      art({
        source: "BBC World News",
        title: "Federal Reserve holds rates at 4.25% amid inflation concerns",
        summary:
          "The US central bank kept its benchmark rate at 4.25%, citing persistent inflation and a resilient labour market, in a decision widely anticipated by economists.",
        url: "https://bbc.com/fed-hold",
        publishedAt: new Date(t0 + 1_800_000).toISOString(),
        language: "en",
      }),
    ]),
  );

  // ── 3. Fed → Reuters → local rewrite ─────────────────────────────────
  setupDb();
  await report(
    "3) FED PRIMARY -> REUTERS -> LOCAL REWRITE",
    cluster([
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
      art({
        source: "Reuters",
        title: WIRE_TITLE,
        summary:
          "Ngân hàng dự trữ liên bang quyết định giữ nguyên lãi suất cơ bản ở mức 4.25% trong cuộc họp tháng 9, the Federal Reserve said in a statement.",
        url: "https://reuters.com/fed-rate",
        publishedAt: new Date(t0).toISOString(),
        language: "vi",
      }),
      art({
        source: "Tuổi Trẻ",
        title: "Fed giữ nguyên lãi suất 4.25%, lạm phát vẫn cao",
        summary:
          "Theo Reuters, Fed quyết định giữ lãi suất ở mức 4.25%. Lạm phát tại Mỹ vẫn cao hơn mục tiêu 2% và Fed cần thêm dữ liệu.",
        url: "https://tuoitre.vn/fed-giu-lai-suat",
        publishedAt: new Date(t0 + 3_600_000).toISOString(),
        language: "vi",
      }),
    ]),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
