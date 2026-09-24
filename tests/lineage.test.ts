/**
 * Information Lineage regression — the spec's required cases:
 * wire copies vs independent corroboration, explicit attribution,
 * primary→publisher chains, cross-language, and the negative space
 * (same event ≠ same lineage). Plus Phase A provenance hotfixes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool, getPool } from "../lib/db/pool";
import { persistCluster } from "../lib/db/writer";
import { extractClaims } from "../lib/db/extract";
import { getEventView } from "../lib/db/read";
import {
  classifyLineage,
  independence,
  type LineageDoc,
} from "../lib/lineage";
import type { Article, StoryCluster } from "../lib/model";

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

function cluster(articles: Article[]): StoryCluster {
  return {
    id: "c1",
    title: articles[0].title,
    summary: articles[0].summary,
    leadArticle: articles[0],
    articles,
    sources: articles.map((a) => ({ name: a.source, url: a.url })),
    topic: "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: articles[0].publishedAt,
  };
}

const WIRE_TITLE = "Bão lớn: 20 chuyến bay bị hủy";
const WIRE_SUMMARY =
  "Bão lớn đổ bộ khiến 20 chuyến bay bị hủy, hàng nghìn hành khách " +
  "mắc kẹt tại các sân bay trong khu vực.";

const wireCopy = (source: string, i: number): Article =>
  art({
    source,
    title: WIRE_TITLE,
    summary: WIRE_SUMMARY,
    url: `https://${source.replace(/\s/g, "").toLowerCase()}.com/wire-${i}`,
    language: "vi",
  });

test("case 1: Reuters + 9 near-copies → 10 raw, 1 independent origin", async () => {
  setupDb();
  const origin = art({
    source: "Reuters",
    title: WIRE_TITLE,
    summary: WIRE_SUMMARY,
    url: "https://reuters.com/wire-0",
    language: "vi",
    publishedAt: "2026-09-24T08:00:00Z",
  });
  const c1 = cluster([origin]);
  const r1 = await persistCluster(c1, extractClaims(c1));

  const copies = Array.from({ length: 9 }, (_, i) =>
    wireCopy(`Outlet ${i + 1}`, i + 1),
  );
  // near-copies arrive a few minutes later in one cluster
  copies.forEach(
    (a, i) =>
      (a.publishedAt = `2026-09-24T08:${String(i + 2).padStart(2, "0")}:00Z`),
  );
  const c2 = cluster(copies);
  const r2 = await persistCluster(c2, extractClaims(c2));
  assert.equal(r2.eventId, r1.eventId);

  const view = await getEventView(r1.eventId);
  assert.equal(view!.confidence.rawSourceCount, 10);
  assert.equal(view!.confidence.independentOrigins, 1);
  assert.equal(view!.confidence.syndicatedSources, 9);
});

test("case 2: Reuters + BBC independent → 2 raw, 2 independent origins", async () => {
  setupDb();
  const c1 = cluster([
    art({
      source: "Reuters",
      title: WIRE_TITLE,
      summary: WIRE_SUMMARY,
      url: "https://reuters.com/x1",
      language: "vi",
    }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  const c2 = cluster([
    art({
      source: "BBC World News",
      title: "Storm grounds travel — 20 flights cancelled",
      summary:
        "The BBC has confirmed 20 flights were cancelled as the storm " +
        "made landfall, in what airports called the worst disruption " +
        "this year.",
      url: "https://bbc.com/y2",
      language: "en",
    }),
  ]);
  await persistCluster(c2, extractClaims(c2));
  const view = await getEventView(r1.eventId);
  assert.equal(view!.confidence.rawSourceCount, 2);
  assert.equal(view!.confidence.independentOrigins, 2);
  assert.equal(view!.confidence.syndicatedSources, 0);
});

test("case 3: 'Theo Reuters' attribution links to the Reuters document", async () => {
  setupDb();
  const c1 = cluster([
    art({
      source: "Reuters",
      title: "Bão lớn: 20 chuyến bay bị hủy",
      summary: "Bão lớn khiến 20 chuyến bay bị hủy trong khu vực.",
      url: "https://reuters.com/fed-1",
      publishedAt: "2026-09-24T08:00:00Z",
    }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  const c2 = cluster([
    art({
      source: "VnExpress",
      title: "Theo Reuters: Bão lớn 20 chuyến bay bị hủy",
      summary:
        "Theo Reuters đưa tin, bão lớn khiến 20 chuyến bay bị hủy " +
        "trong khu vực hôm nay.",
      url: "https://vnexpress.net/fed-vn",
      publishedAt: "2026-09-24T09:00:00Z",
    }),
  ]);
  await persistCluster(c2, extractClaims(c2));

  const { rows } = await getPool().query<{
    relation: string;
    parent_source: string | null;
  }>(
    `SELECT l.relation::text AS relation, s.name AS parent_source
     FROM evidence_lineage l
     LEFT JOIN evidence_documents pd ON pd.id = l.parent_document_id
     LEFT JOIN sources s ON s.id = pd.source_id
     JOIN evidence_documents cd ON cd.id = l.child_document_id
     JOIN sources cs ON cs.id = cd.source_id
     WHERE cs.name = 'VnExpress'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relation, "quoted");
  assert.equal(rows[0].parent_source, "Reuters");
});

test("case 4: Reuters + official agency → 2 origins, 1 primary, claim confirmed", async () => {
  setupDb();
  const c1 = cluster([
    art({ source: "Reuters", title: "Bão lớn: 20 chuyến bay bị hủy" }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  const c2 = cluster([
    art({
      source: "Cục Hàng không",
      title: "Bão lớn: 20 chuyến bay bị hủy",
      ingest: {
        sourceKind: "primary",
        discoveredVia: "official_rss",
      },
    }),
  ]);
  await persistCluster(c2, extractClaims(c2), {
    sourceMeta: { "Cục Hàng không": { kind: "primary" } },
  });
  const view = await getEventView(r1.eventId);
  assert.equal(view!.confidence.independentOrigins, 2);
  assert.equal(view!.confidence.primaryOrigins, 1);
  assert.equal(view!.claims[0].state, "confirmed");
});

test("case 5: Fed → Reuters → local rewrite — chain, not 3 independents", async () => {
  setupDb();
  const fed = art({
    source: "Federal Reserve",
    title: "Federal Reserve holds interest rate at 4.5%",
    summary:
      "The Committee decided to maintain the target for the federal " +
      "funds rate at 4.5 percent.",
    url: "https://federalreserve.gov/fomc-0924.htm",
    language: "en",
    publishedAt: "2026-09-24T08:00:00Z",
    ingest: { sourceKind: "primary", discoveredVia: "official_rss" },
  });
  const c1 = cluster([fed]);
  const r1 = await persistCluster(c1, extractClaims(c1), {
    sourceMeta: { "Federal Reserve": { kind: "primary" } },
  });

  const reuters = art({
    source: "Reuters",
    title: "Fed giữ lãi suất 4.5% theo thông cáo mới nhất",
    summary:
      "Theo thông cáo của Fed, lãi suất được giữ nguyên ở mức 4.5% " +
      "trong cuộc họp tháng này.",
    url: "https://reuters.com/fed-hold",
    publishedAt: "2026-09-24T08:30:00Z",
  });
  const c2 = cluster([reuters]);
  await persistCluster(c2, extractClaims(c2));

  const local = art({
    source: "Tuổi Trẻ",
    title: "Fed giữ lãi suất 4.5% theo thông cáo mới nhất",
    summary:
      "Theo thông cáo của Fed, lãi suất được giữ nguyên ở mức 4.5% " +
      "trong cuộc họp tháng này.",
    url: "https://tuoitre.vn/fed-hold",
    publishedAt: "2026-09-24T09:00:00Z",
  });
  const c3 = cluster([local]);
  await persistCluster(c3, extractClaims(c3));

  const view = await getEventView(r1.eventId);
  // the whole chain is ONE information origin rooted at the Fed —
  // Reuters and the local rewrite are derivatives, not independent
  // confirmations. Three sources ≠ three origins.
  assert.equal(view!.confidence.independentOrigins, 1);
  assert.equal(view!.confidence.primaryOrigins, 1);
  assert.equal(view!.confidence.syndicatedSources, 2);

  const { rows } = await getPool().query<{
    child: string;
    relation: string;
    parent: string | null;
  }>(
    `SELECT cs.name AS child, l.relation::text AS relation,
            ps.name AS parent
     FROM evidence_lineage l
     JOIN evidence_documents cd ON cd.id = l.child_document_id
     JOIN sources cs ON cs.id = cd.source_id
     LEFT JOIN evidence_documents pd ON pd.id = l.parent_document_id
     LEFT JOIN sources ps ON ps.id = pd.source_id
     ORDER BY cs.name`,
  );
  assert.deepEqual(
    rows.map((r) => [r.child, r.relation, r.parent]),
    [
      ["Federal Reserve", "original", null],
      ["Reuters", "press_release_based", "Federal Reserve"],
      // Tuổi Trẻ copies Reuters' text verbatim — wire-chain link
      ["Tuổi Trẻ", "syndicated", "Reuters"],
    ],
  );
});

test("case 7: two journalists, same event, different text → separate origins", async () => {
  setupDb();
  const c1 = cluster([
    art({
      source: "VnExpress",
      title: "Cháy chợ Đồng Xuân thiệt hại lớn",
      summary:
        "Đám cháy bùng lên lúc rạng sáng, thiêu rụi hàng chục gian hàng. " +
        "Không có thương vong.",
      url: "https://vnexpress.net/chay-cho",
    }),
  ]);
  const r1 = await persistCluster(c1, extractClaims(c1));
  const c2 = cluster([
    art({
      source: "Tuổi Trẻ",
      title: "Hỏa hoạn tại khu vực chợ cổ nhất Hà Nội",
      summary:
        "Lực lượng cứu hỏa đã khống chế ngọn lửa sau 3 giờ. Nguyên nhân " +
        "đang được điều tra.",
      url: "https://tuoitre.vn/hoa-hoan",
    }),
  ]);
  // same event would merge only via resolver; for the independence count
  // we just assert the lineage layer never conflates different text
  const docs: LineageDoc[] = [
    {
      documentId: "a",
      source: "VnExpress",
      title: "Cháy chợ Đồng Xuân thiệt hại lớn",
      summary: "Đám cháy bùng lên lúc rạng sáng, thiêu rụi hàng chục gian hàng.",
      publishedAt: "2026-09-24T08:00:00Z",
      url: "u1",
    },
    {
      documentId: "b",
      source: "Tuổi Trẻ",
      title: "Hỏa hoạn tại khu vực chợ cổ nhất Hà Nội",
      summary: "Lực lượng cứu hỏa đã khống chế ngọn lửa sau 3 giờ.",
      publishedAt: "2026-09-24T09:00:00Z",
      url: "u2",
    },
  ];
  const asrt = classifyLineage(docs[1], [docs[0]]);
  assert.equal(asrt.relation, "original");
  void r1;
});

/* ------------------------- Phase A regressions ------------------------- */

test("A1: SEC filings from two issuers → 2 source rows, no domain conflict", async () => {
  setupDb();
  const mk = (issuer: string, acc: string) =>
    art({
      source: issuer,
      title: `${issuer} — 8-K filing`,
      url: `https://www.sec.gov/Archives/edgar/data/1/${acc}/d8k.htm`,
      language: "en",
      ingest: {
        sourceKind: "primary",
        discoveredVia: "official_api",
        discoveryProvider: "SEC EDGAR",
        externalId: acc,
        documentType: "filing",
        structuredData: { cik: "1", accession: acc, form: "8-K" },
      },
    });
  const c1 = cluster([mk("AMAZON COM INC", "a1")]);
  await persistCluster(c1, extractClaims(c1));
  const c2 = cluster([mk("ORACLE CORP", "o1")]);
  await persistCluster(c2, extractClaims(c2));

  const { rows } = await getPool().query<{
    name: string;
    domain: string | null;
  }>(`SELECT name, domain FROM sources ORDER BY name`);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("AMAZON COM INC"));
  assert.ok(names.includes("ORACLE CORP"));
  // neither issuer may claim sec.gov as its identity domain
  assert.ok(rows.every((r) => r.domain !== "sec.gov"));

  const { rows: disc } = await getPool().query<{ provider: string }>(
    `SELECT DISTINCT provider FROM evidence_discoveries ORDER BY provider`,
  );
  assert.deepEqual(disc.map((d) => d.provider), ["SEC EDGAR"]);
});

test("A2: late metadata enrichment merges, no new EvidenceVersion", async () => {
  setupDb();
  const url = `https://congbao.chinhphu.vn/doc-${randomUUID()}`;
  const base = {
    url,
    title: "Nghị định 102/2026/NĐ-CP",
    source: "Công báo Chính phủ",
    ingest: {
      sourceKind: "primary" as const,
      discoveredVia: "official_rss" as const,
      structuredData: { stream: "van-ban-moi" },
    },
  };
  const c1 = cluster([art(base)]);
  await persistCluster(c1, extractClaims(c1));

  // cycle 2: same editorial content + detail fetch succeeded
  const c2 = cluster([
    art({
      ...base,
      ingest: {
        ...base.ingest,
        structuredData: {
          stream: "van-ban-moi",
          soKyHieu: "102/2026/NĐ-CP",
          coQuan: "Chính phủ",
          ngayHieuLuc: "01/11/2026",
          pdfUrl: "https://cdn.example/nd102.pdf",
        },
      },
    }),
  ]);
  await persistCluster(c2, extractClaims(c2));

  const { rows: vers } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM evidence_versions`,
  );
  assert.equal(vers[0].c, 1, "editorial unchanged → one version");

  const { rows: docs } = await getPool().query<{
    metadata: Record<string, unknown>;
  }>(`SELECT metadata FROM evidence_documents`);
  assert.equal(docs[0].metadata.soKyHieu, "102/2026/NĐ-CP");
  assert.equal(docs[0].metadata.pdfUrl, "https://cdn.example/nd102.pdf");

  const { rows: obs } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM evidence_metadata_observations`,
  );
  // the initial insert already carries {stream} — only the LATE
  // enrichment is a delta event worth auditing
  assert.equal(obs[0].c, 1, "enrichment event logged once");

  const { rows: disc } = await getPool().query<{
    metadata: Record<string, unknown>;
  }>(`SELECT metadata FROM evidence_discoveries`);
  assert.equal(
    disc[0].metadata.soKyHieu,
    "102/2026/NĐ-CP",
    "discovery metadata moved forward too",
  );
});

test("A3: source_updated_at is explicit-only, never publishedAt", async () => {
  setupDb();
  const url = `https://x.vn/${randomUUID()}`;
  const c1 = cluster([
    art({ url, title: "Tin A", publishedAt: "2026-09-20T08:00:00Z" }),
  ]);
  await persistCluster(c1, extractClaims(c1));
  const { rows } = await getPool().query<{
    published_at: Date;
    source_updated_at: Date | null;
  }>(
    `SELECT d.published_at, v.source_updated_at
     FROM evidence_documents d
     JOIN evidence_versions v ON v.id = d.current_version_id`,
  );
  assert.equal(
    new Date(rows[0].published_at).toISOString(),
    "2026-09-20T08:00:00.000Z",
  );
  assert.equal(rows[0].source_updated_at, null);

  // explicit updated timestamp is honored
  const url2 = `https://x.vn/${randomUUID()}`;
  const c2 = cluster([
    art({
      url: url2,
      title: "Tin B",
      publishedAt: "2026-09-20T08:00:00Z",
      ingest: {
        sourceKind: "publisher",
        discoveredVia: "rss",
        sourceUpdatedAt: "2026-09-21T10:00:00Z",
      },
    }),
  ]);
  await persistCluster(c2, extractClaims(c2));
  const { rows: r2 } = await getPool().query<{
    source_updated_at: Date | null;
  }>(
    `SELECT v.source_updated_at FROM evidence_documents d
     JOIN evidence_versions v ON v.id = d.current_version_id
     WHERE d.canonical_url LIKE '%${url2.slice(8)}%'`,
  );
  assert.equal(
    r2[0].source_updated_at && new Date(r2[0].source_updated_at).toISOString(),
    "2026-09-21T10:00:00.000Z",
  );
});

test("independence(): math on mixed graph", () => {
  const docs: LineageDoc[] = ["Reuters", "SiteA", "SiteB", "BBC", "Fed"].map(
    (s, i) => ({
      documentId: `d${i}`,
      source: s,
      sourceKind: s === "Fed" ? "primary" : "publisher",
      title: "",
      summary: "",
      publishedAt: "",
      url: "",
    }),
  );
  const asrts = new Map([
    ["d0", { parentDocumentId: null, relation: "original" as const, confidence: 1, method: "rule" as const, evidence: {} }],
    ["d1", { parentDocumentId: "d0", relation: "syndicated" as const, confidence: 1, method: "rule" as const, evidence: {} }],
    ["d2", { parentDocumentId: "d0", relation: "syndicated" as const, confidence: 1, method: "rule" as const, evidence: {} }],
    ["d3", { parentDocumentId: null, relation: "original" as const, confidence: 1, method: "rule" as const, evidence: {} }],
    ["d4", { parentDocumentId: null, relation: "original" as const, confidence: 1, method: "rule" as const, evidence: {} }],
  ]);
  const ind = independence(docs, asrts);
  assert.equal(ind.rawSources, 5);
  assert.equal(ind.independentOrigins, 3); // Reuters-tree, BBC, Fed
  assert.equal(ind.primaryOrigins, 1);
  assert.equal(ind.syndicatedSources, 2);
  assert.equal(ind.unknownOrigins, 0);
});
