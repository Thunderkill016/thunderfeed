/**
 * Công báo Chính phủ Việt Nam — official gazette adapter.
 * Two official RSS streams: gazette issues (số Công báo) and individual
 * legal documents (văn bản mới ban hành). RSS items are thin — the legal
 * metadata lives on each document's "Thuộc tính" page, so the adapter
 * enriches the newest items with a bounded detail fetch.
 */
import Parser from "rss-parser";
import { createHash } from "node:crypto";
import { cleanText, safeUrl } from "../news";
import type { Feed } from "../feeds";
import type { Article, SourceStatus } from "../model";

const parser = new Parser();
const FETCH_TIMEOUT = 10_000;
const MAX_DETAIL_FETCHES = 8;

const STREAMS = [
  {
    key: "cong-bao-moi",
    url: "https://congbao.chinhphu.vn/cac-so-cong-bao-moi-dang.rss",
    docClass: "gazette_issue" as const,
  },
  {
    key: "van-ban-moi",
    url: "https://congbao.chinhphu.vn/cac-van-ban-moi-ban-hanh.rss",
    docClass: "legal_document" as const,
  },
];

const CONGBAO_FEED: Feed = {
  id: "congbao",
  name: "Công báo Chính phủ",
  topic: "vietnam",
  url: STREAMS[0].url,
  language: "vi",
  region: "vietnam",
  country: "VN",
  sourceKind: "primary",
  discovery: "official_rss",
  documentType: "legal_document",
};

/** Field labels on the document's "Thuộc tính" attributes panel. */
const ATTR_LABELS = [
  ["loaiVanBan", "Loại văn bản"],
  ["soKyHieu", "Số, ký hiệu"],
  ["coQuan", "Cơ quan ban hành"],
  ["ngayBanHanh", "Ngày ban hành"],
  ["ngayHieuLuc", "Ngày hiệu lực"],
  ["soCongBao", "Số Công báo"],
] as const;

function cellValue(html: string, label: string): string | undefined {
  // label cell followed by a value cell; tolerate markup between them
  const re = new RegExp(
    `${label}[\\s\\S]{0,200}?<t[dh][^>]*>([\\s\\S]*?)</t[dh]>`,
    "i",
  );
  const raw = re.exec(html)?.[1];
  if (!raw) return undefined;
  const text = cleanText(raw);
  return text || undefined;
}

function fileLinks(html: string): { pdf?: string; docx?: string } {
  const out: { pdf?: string; docx?: string } = {};
  for (const m of html.matchAll(/href="([^"]+?\.(?:pdf|docx))[^"]*"/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (/\.pdf/i.test(href) && !out.pdf) out.pdf = href;
    else if (/\.docx?/i.test(href) && !out.docx) out.docx = href;
  }
  return out;
}

/** Extract the legal attributes panel + file links from a detail page. */
export function parseCongBaoDetail(html: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, label] of ATTR_LABELS) {
    const v = cellValue(html, label);
    if (v) data[key] = v;
  }
  const { pdf, docx } = fileLinks(html);
  if (pdf) data.pdfUrl = pdf;
  if (docx) data.docxUrl = docx;
  return data;
}

async function fetchDetail(
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { "User-Agent": "ThunderFeed/0.1 (public RSS reader)" },
    });
    if (!res.ok) return null;
    const data = parseCongBaoDetail(await res.text());
    return Object.keys(data).length ? data : null;
  } catch {
    return null; // per-item enrichment is fail-open
  }
}

export async function fetchCongBao(): Promise<{
  articles: Article[];
  status: SourceStatus;
}> {
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = {
    id: CONGBAO_FEED.id,
    name: CONGBAO_FEED.name,
    topic: CONGBAO_FEED.topic,
    url: CONGBAO_FEED.url,
    checkedAt,
  };
  try {
    const articles: Article[] = [];
    for (const stream of STREAMS) {
      const res = await fetch(stream.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: { "User-Agent": "ThunderFeed/0.1 (public RSS reader)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${stream.key}`);
      const parsed = await parser.parseString(await res.text());
      for (const item of parsed.items.slice(0, 15)) {
        const url = safeUrl(item.link);
        if (!url) continue;
        // van-ban items ship an empty <title> — the description carries it
        const title =
          cleanText(item.title ?? "") ||
          cleanText(item.contentSnippet ?? item.content ?? "").slice(0, 160);
        const published = Date.parse(item.isoDate ?? item.pubDate ?? "");
        if (!title || !Number.isFinite(published)) continue;
        articles.push({
          id: createHash("sha256").update(url).digest("hex").slice(0, 20),
          title,
          summary: cleanText(item.contentSnippet ?? item.content ?? "").slice(
            0,
            1400,
          ),
          url,
          image: null,
          publishedAt: new Date(published).toISOString(),
          source: CONGBAO_FEED.name,
          topic: CONGBAO_FEED.topic,
          headline: false,
          appearances: [{ source: CONGBAO_FEED.name, url }],
          language: "vi",
          region: "vietnam",
          wire: false,
          ingest: {
            sourceKind: "primary",
            discoveredVia: "official_rss",
            discoveryProvider: "Công báo CP",
            sourceDomain: "congbao.chinhphu.vn",
            documentType: "legal_document",
            structuredData: { stream: stream.key, docClass: stream.docClass },
          },
        });
      }
    }
    // enrich the newest items with the attributes panel — bounded per cycle
    await Promise.all(
      articles.slice(0, MAX_DETAIL_FETCHES).map(async (a) => {
        const detail = await fetchDetail(a.url);
        if (detail && a.ingest?.structuredData)
          Object.assign(a.ingest.structuredData, detail);
      }),
    );
    return {
      articles,
      status: {
        ...base,
        latencyMs: Date.now() - t0,
        status: articles.length ? "ok" : "empty",
        count: articles.length,
      },
    };
  } catch (error) {
    return {
      articles: [],
      status: {
        ...base,
        latencyMs: Date.now() - t0,
        status: "error",
        count: 0,
        error:
          error instanceof Error ? error.message.slice(0, 140) : "Fetch failed",
      },
    };
  }
}
