/**
 * Ingest provenance regression — source/discovery separation, multi-channel
 * discoveries, and deterministic adapter fixtures (no live network except
 * the stubbed-fetch rate-limit case).
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
import { parseCongBaoDetail } from "../lib/adapters/congbao";
import { filingsToArticles } from "../lib/adapters/secEdgar";
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

test("provenance: same document via RSS then GDELT → 1 doc, 1 version, 2 discovery paths", async () => {
  setupDb();
  const url = `https://x.vn/${randomUUID()}`;
  const base = { url, title: "Giá xăng tăng 500 đồng/lít", source: "VnExpress" };
  const viaRss = cluster([
    art({
      ...base,
      ingest: { sourceKind: "publisher", discoveredVia: "rss" },
    }),
  ]);
  await persistCluster(viaRss, extractClaims(viaRss));

  const viaGdelt = cluster([
    art({
      ...base,
      ingest: {
        sourceKind: "publisher",
        discoveredVia: "gdelt",
        discoveryProvider: "GDELT",
      },
    }),
  ]);
  await persistCluster(viaGdelt, extractClaims(viaGdelt));

  const { rows: docs } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM evidence_documents`,
  );
  assert.equal(docs[0].c, 1);

  const { rows: vers } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM evidence_versions`,
  );
  assert.equal(vers[0].c, 1); // same content — no new version

  const { rows: paths } = await getPool().query<{
    channel: string;
    provider: string;
  }>(
    `SELECT channel::text, provider FROM evidence_discoveries
     ORDER BY first_seen_at, channel`,
  );
  assert.deepEqual(paths, [
    { channel: "rss", provider: "" },
    { channel: "gdelt", provider: "GDELT" },
  ]);
});

test("provenance: re-observation on the same channel bumps last_seen, still 1 path", async () => {
  setupDb();
  const url = `https://x.vn/${randomUUID()}`;
  const mk = () =>
    cluster([
      art({
        url,
        title: "Tin giữ nguyên",
        ingest: {
          sourceKind: "publisher",
          discoveredVia: "gdelt",
          discoveryProvider: "GDELT",
        },
      }),
    ]);
  await persistCluster(mk(), []);
  await persistCluster(mk(), []);

  const { rows } = await getPool().query<{ c: number; bumped: boolean }>(
    `SELECT count(*)::int AS c,
            bool_or(last_seen_at > first_seen_at) AS bumped
     FROM evidence_discoveries`,
  );
  assert.equal(rows[0].c, 1);
  assert.equal(rows[0].bumped, true);
});

test("discovery provider: GDELT-found VOV article → source is VOV, never GDELT", async () => {
  setupDb();
  const a = art({
    url: "https://vov.vn/chinh-tri/tin-moi-1",
    title: "Quốc hội thảo luận dự luật mới",
    source: "vov.vn", // GDELT emits domains, not display names
    ingest: {
      sourceKind: "publisher",
      discoveredVia: "gdelt",
      discoveryProvider: "GDELT",
      sourceDomain: "vov.vn",
    },
  });
  const c = cluster([a]);
  await persistCluster(c, extractClaims(c));

  const { rows } = await getPool().query<{ name: string; via: string }>(
    `SELECT s.name, ed.discovered_via::text AS via
     FROM evidence_documents ed JOIN sources s ON s.id = ed.source_id`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "VOV");
  assert.equal(rows[0].via, "gdelt");

  const { rows: gd } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM sources WHERE name = 'GDELT'`,
  );
  assert.equal(gd[0].c, 0);
});

test("congbao fixture: attributes panel preserves legal metadata + file links", () => {
  const html = `
    <table>
      <tr><td>Loại văn bản</td><td>Nghị định</td></tr>
      <tr><td>Số, ký hiệu</td><td>102/2026/NĐ-CP</td></tr>
      <tr><td>Cơ quan ban hành</td><td>Chính phủ</td></tr>
      <tr><td>Ngày ban hành</td><td>15/09/2026</td></tr>
      <tr><td>Ngày hiệu lực</td><td>01/11/2026</td></tr>
      <tr><td>Số Công báo</td><td>955-956</td></tr>
    </table>
    <a href="/uploads/2026/09/nd102.pdf">Tải PDF</a>
    <a href="/uploads/2026/09/nd102.docx">Tải DOCX</a>`;
  const data = parseCongBaoDetail(html);
  assert.equal(data.loaiVanBan, "Nghị định");
  assert.equal(data.soKyHieu, "102/2026/NĐ-CP");
  assert.equal(data.coQuan, "Chính phủ");
  assert.equal(data.ngayBanHanh, "15/09/2026");
  assert.equal(data.ngayHieuLuc, "01/11/2026");
  assert.equal(data.soCongBao, "955-956");
  assert.equal(data.pdfUrl, "/uploads/2026/09/nd102.pdf");
  assert.equal(data.docxUrl, "/uploads/2026/09/nd102.docx");
});

test("sec fixture: 8-K preserves CIK, accession, form, dates, primary doc", () => {
  const issuer = { name: "NVIDIA Corp.", cik: "0001045810" };
  const now = Date.parse("2026-09-24T00:00:00Z");
  const submissions = {
    name: "NVIDIA Corp.",
    filings: {
      recent: {
        form: ["8-K", "SC 13G", "10-Q"],
        filingDate: ["2026-09-20", "2026-09-20", "2026-09-22"],
        reportDate: ["2026-09-19", "", "2026-08-31"],
        accessionNumber: [
          "0001045810-26-000123",
          "0001045810-26-000124",
          "0001045810-26-000125",
        ],
        primaryDocument: ["d8k.htm", "sc13g.htm", "d10q.htm"],
      },
    },
  };
  const articles = filingsToArticles(issuer, submissions, now);
  // SC 13G is not a priority form — filtered out
  assert.equal(articles.length, 2);

  const eightK = articles[0];
  assert.equal(eightK.source, "NVIDIA Corp."); // issuer is the source, not EDGAR
  assert.equal(eightK.ingest?.sourceKind, "primary");
  assert.equal(eightK.ingest?.discoveredVia, "official_api");
  assert.equal(eightK.ingest?.discoveryProvider, "SEC EDGAR");
  assert.equal(eightK.ingest?.documentType, "filing");
  assert.equal(eightK.ingest?.externalId, "0001045810-26-000123");

  const sd = eightK.ingest?.structuredData as Record<string, unknown>;
  assert.equal(sd.cik, "0001045810");
  assert.equal(sd.accession, "0001045810-26-000123");
  assert.equal(sd.form, "8-K");
  assert.equal(sd.filingDate, "2026-09-20");
  assert.equal(sd.reportDate, "2026-09-19");
  assert.equal(sd.primaryDocument, "d8k.htm");
  assert.equal(sd.issuer, "NVIDIA Corp.");
  assert.ok(
    eightK.url.includes(
      "sec.gov/Archives/edgar/data/1045810/000104581026000123/d8k.htm",
    ),
  );
});

test("rate limit: SEC 429 → rate_limited status, empty articles, no crash", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("rate limited", { status: 429 }))) as never;
  try {
    const { fetchSecEdgar } = await import("../lib/adapters/secEdgar");
    const { articles, status } = await fetchSecEdgar();
    assert.equal(articles.length, 0);
    assert.equal(status.status, "rate_limited");
    assert.equal(status.httpStatus, 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rate limit: all issuers 403 → rate_limited, NOT fake empty", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("forbidden", { status: 403 }))) as never;
  try {
    const { fetchSecEdgar } = await import("../lib/adapters/secEdgar");
    const { articles, status } = await fetchSecEdgar();
    assert.equal(articles.length, 0);
    assert.equal(status.status, "rate_limited"); // never "empty" on refusal
    assert.equal(status.httpStatus, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sec: genuinely quiet window (ok responses, no priority forms) → empty", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          name: "Test Co.",
          filings: {
            recent: {
              form: ["4", "144"],
              filingDate: ["2026-09-23", "2026-09-23"],
              reportDate: ["", ""],
              accessionNumber: ["0000000000-26-000001", "0000000000-26-000002"],
              primaryDocument: ["f4.htm", "f144.htm"],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as never;
  try {
    const { fetchSecEdgar } = await import("../lib/adapters/secEdgar");
    const { articles, status } = await fetchSecEdgar();
    assert.equal(articles.length, 0);
    assert.equal(status.status, "empty"); // honest empty — upstream answered fine
  } finally {
    globalThis.fetch = realFetch;
  }
});
