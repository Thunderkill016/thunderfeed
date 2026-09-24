import Parser from "rss-parser";
import { decodeHTML } from "entities";
import { createHash } from "node:crypto";
import { get as httpsGet } from "node:https";
import { feeds, type Feed } from "./feeds";
import { fetchCongBao } from "./adapters/congbao";
import { fetchSecEdgar } from "./adapters/secEdgar";
import { mediaInfoFor } from "./mediaData";
import { normalizeText, type Article, type SourceStatus } from "./model";

const parser = new Parser();
const FETCH_TIMEOUT = 8_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_AGE = 7 * 24 * 60 * 60_000;
const CLOCK_SKEW_ALLOWANCE = 10 * 60_000;
const CONCURRENCY = 6;

export interface RawNews {
  articles: Article[];
  sources: SourceStatus[];
  fetchedAt: string;
}

export function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function cleanText(value: string): string {
  return decodeHTML(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toArticle(
  item: Parser.Item,
  feed: Feed,
  now = Date.now(),
): Article | null {
  const url = safeUrl(item.link);
  const title = cleanText(item.title ?? "");
  // RDF feeds (e.g. Nikkei Asia) carry the date in Dublin Core `dc:date`
  const dcDate = (item as Record<string, unknown>)["dc:date"];
  let published = Date.parse(
    item.isoDate ?? item.pubDate ?? (typeof dcDate === "string" ? dcDate : ""),
  );
  // wire feeds that omit dates entirely are stamped at fetch time
  if (!Number.isFinite(published) && feed.undatedAsFresh) published = now;
  if (
    !url ||
    !title ||
    !Number.isFinite(published) ||
    published > now + CLOCK_SKEW_ALLOWANCE ||
    now - published > MAX_ARTICLE_AGE
  )
    return null;
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()])
    if (key.startsWith("utm_")) canonical.searchParams.delete(key);
  const image = safeUrl(
    item.enclosure?.url ??
      item.content?.match(/<img[^>]+src=["']([^"']+)/i)?.[1],
  );
  return {
    id: createHash("sha256").update(canonical.href).digest("hex").slice(0, 20),
    title,
    summary: cleanText(item.contentSnippet ?? item.content ?? "").slice(
      0,
      1400,
    ),
    url: canonical.href,
    image,
    publishedAt: new Date(published).toISOString(),
    source: feed.name,
    topic: feed.topic,
    headline: feed.headline ?? false,
    appearances: [{ source: feed.name, url: canonical.href }],
    language: feed.language ?? "vi",
    region: feed.region,
    wire: feed.wire ?? false,
    ingest: {
      sourceKind: feed.sourceKind ?? "publisher",
      discoveredVia:
        feed.format === "news-sitemap"
          ? "news_sitemap"
          : (feed.discovery ?? "rss"),
      discoveryProvider: feed.discoveryProvider,
      sourceDomain: canonical.hostname.replace(/^www\./, ""),
      documentType: feed.documentType,
    },
  };
}

export function deduplicate(articles: Article[]): Article[] {
  const byUrl = new Map<string, Article>();
  for (const article of articles) {
    const existing = byUrl.get(article.url);
    if (existing) {
      if (!article.headline) existing.topic = article.topic;
      existing.headline ||= article.headline;
    } else
      byUrl.set(article.url, {
        ...article,
        appearances: [...article.appearances],
      });
  }
  const byTitle = new Map<string, Article>();
  for (const article of byUrl.values()) {
    const title = normalizeText(article.title);
    const key = title.length >= 45 ? title : article.url;
    const existing = byTitle.get(key);
    if (existing)
      existing.appearances.push(
        ...article.appearances.filter(
          (a) => !existing.appearances.some((b) => b.url === a.url),
        ),
      );
    else byTitle.set(key, article);
  }
  return [...byTitle.values()].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

/**
 * Some feeds (e.g. vietnamnews.vn) ship UTF-16 — decode via BOM first, then
 * NUL-byte density: odd-position NULs mean UTF-16LE, even-position UTF-16BE.
 */
function decodeFeedBytes(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return buf.swap16().toString("utf16le");
  const head = buf.subarray(0, Math.min(64, buf.length));
  let oddNuls = 0;
  let evenNuls = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) i % 2 === 0 ? evenNuls++ : oddNuls++;
  }
  if (oddNuls > 8 && oddNuls > evenNuls) return buf.toString("utf16le");
  if (evenNuls > 8) return buf.swap16().toString("utf16le");
  return buf.toString("utf8");
}

/** Carrier for errors that must surface as a health status, not a stack. */
class FetchHealthError extends Error {
  constructor(
    readonly kind: "rate_limited" | "timeout" | "error",
    message: string,
  ) {
    super(message);
  }
}

async function fetchFeed(
  feed: Feed,
): Promise<{ articles: Article[]; status: SourceStatus }> {
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  let httpStatus: number | undefined;
  let retryAfter: string | undefined;
  const statusBase = {
    id: feed.id,
    name: feed.name,
    topic: feed.topic,
    url: feed.url,
    checkedAt,
    latencyMs: 0,
  };
  try {
    const response = await fetch(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        "User-Agent": "ThunderFeed/0.1 (public RSS reader)",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });
    httpStatus = response.status;
    retryAfter = response.headers.get("retry-after") ?? undefined;
    if (response.status === 429)
      throw new FetchHealthError("rate_limited", "HTTP 429");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error("Feed exceeds size limit");
      }
      chunks.push(value);
    }
    // some feeds (baodautu) emit whitespace before <?xml — strict parsers reject
    const body = decodeFeedBytes(Buffer.concat(chunks)).trimStart();
    const articles =
      feed.format === "news-sitemap"
        ? parseNewsSitemap(body, feed, Date.now())
        : (await parser.parseString(body)).items
            .map((item) => toArticle(item, feed))
            .filter((a): a is Article => a !== null);
    return {
      articles,
      status: {
        ...statusBase,
        latencyMs: Date.now() - t0,
        httpStatus,
        status: articles.length ? "ok" : "empty",
        count: articles.length,
      },
    };
  } catch (error) {
    // abort/timeout is its own class — the source may be slow, not dead
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    const kind =
      error instanceof FetchHealthError
        ? error.kind
        : aborted
          ? "timeout"
          : "error";
    return {
      articles: [],
      status: {
        ...statusBase,
        latencyMs: Date.now() - t0,
        httpStatus,
        retryAfter,
        status: kind,
        count: 0,
        error:
          error instanceof Error ? error.message.slice(0, 140) : "Fetch failed",
      },
    };
  }
}

/**
 * Google News sitemap (<urlset> + news: namespace). Loc + news:title (CDATA)
 * + news:publication_date + image:loc map onto Parser.Item so toArticle
 * applies the same date-freshness and canonicalization rules as RSS.
 */
function parseNewsSitemap(xml: string, feed: Feed, now: number): Article[] {
  const articles: Article[] = [];
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = match[1];
    const imageUrl = /<image:loc>([^<]+)<\/image:loc>/.exec(block)?.[1];
    const item: Parser.Item = {
      link: /<loc>([^<]+)<\/loc>/.exec(block)?.[1],
      title:
        /<news:title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/news:title>/.exec(
          block,
        )?.[1],
      isoDate: /<news:publication_date>([^<]+)<\/news:publication_date>/.exec(
        block,
      )?.[1],
      ...(imageUrl ? { enclosure: { url: imageUrl } } : {}),
    };
    const article = toArticle(item, feed, now);
    if (article) articles.push(article);
  }
  return articles;
}

export async function fetchHackerNews(): Promise<Article[]> {
  try {
    const res = await fetch(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
    );
    if (!res.ok) return [];
    const ids = (await res.json()) as number[];
    const topIds = ids.slice(0, 8);
    const items = await Promise.all(
      topIds.map(async (id): Promise<Article | null> => {
        try {
          const itemRes = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!itemRes.ok) return null;
          const data = (await res.json()) as {
            title?: string;
            url?: string;
            score?: number;
            descendants?: number;
            time?: number;
          } | null;
          if (!data || !data.title) return null;
          const articleUrl =
            safeUrl(data.url) ?? `https://news.ycombinator.com/item?id=${id}`;
          const now = Date.now();
          const published = data.time ? data.time * 1000 : now;
          return {
            id: `hn-${id}`,
            title: cleanText(data.title),
            summary: `Thảo luận công nghệ hàng đầu trên Hacker News (${data.score ?? 0} điểm, ${data.descendants ?? 0} bình luận).`,
            url: articleUrl,
            image: null,
            publishedAt: new Date(published).toISOString(),
            source: "Hacker News",
            topic: "technology",
            headline: true,
            appearances: [{ source: "Hacker News", url: articleUrl }],
            language: "en",
            region: "tech",
            wire: true,
            ingest: {
              sourceKind: "community",
              discoveredVia: "hn",
              discoveryProvider: "Hacker News API",
              externalId: String(id),
            },
          } satisfies Article;
        } catch {
          return null;
        }
      }),
    );
    return items.filter((item): item is Article => item !== null);
  } catch {
    return [];
  }
}

const GDELT_SOURCE_NAME = "GDELT";

/**
 * node:https GET forced to IPv4 — undici fetch times out connecting to
 * api.gdeltproject.org (its IPv6 route is dead from this host while curl's
 * IPv4 path works). Scoped to GDELT so other fetchers keep default DNS order.
 */
function httpsGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { family: 4, timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("timeout", () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
  });
}

/**
 * GDELT DOC 2 API — free, keyless index over outlets we cannot reach via RSS
 * or sitemaps (znews, vtc, cand…). One artlist call per cycle stays inside
 * their 1-req/5s limit; rate-limited responses degrade to an error status.
 */
export async function fetchGdelt(): Promise<{
  articles: Article[];
  status: SourceStatus;
}> {
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc" +
    "?query=vietnam&mode=artlist&maxrecords=75&format=json" +
    "&timespan=1d&sourcelang:vietnamese";
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  const statusBase = {
    id: "gdelt",
    name: GDELT_SOURCE_NAME,
    topic: "vietnam" as const,
    url: "https://www.gdeltproject.org",
    checkedAt,
  };
  try {
    const text = await httpsGetText(url, 20_000);
    if (!text.startsWith("{")) throw new Error("GDELT rate limit");
    const { articles: items } = JSON.parse(text) as {
      articles: {
        url: string;
        title: string;
        seendate: string; // "20260924T153000Z"
        socialimage?: string;
        domain: string;
        language?: string;
      }[];
    };
    const now = Date.now();
    const articles: Article[] = [];
    for (const item of items) {
      const articleUrl = safeUrl(item.url);
      const title = cleanText(item.title ?? "");
      // GDELT seendate "20260924T153000Z" → ISO
      const seen = item.seendate?.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      );
      const published = Date.parse(seen ?? "");
      if (
        !articleUrl ||
        !title ||
        !Number.isFinite(published) ||
        published > now + CLOCK_SKEW_ALLOWANCE ||
        now - published > MAX_ARTICLE_AGE
      )
        continue;
      const canonical = new URL(articleUrl);
      canonical.hash = "";
      for (const key of [...canonical.searchParams.keys()])
        if (key.startsWith("utm_")) canonical.searchParams.delete(key);
      const host = canonical.hostname.replace(/^www\./, "");
      // source = the real outlet (resolved via ownership registry), GDELT is
      // only the discovery layer — appearances must carry the outlet so
      // downstream merge/spectrum logic sees consistent source identity.
      const org = mediaInfoFor("", canonical.href)?.organization ?? host;
      articles.push({
        id: createHash("sha256")
          .update(canonical.href)
          .digest("hex")
          .slice(0, 20),
        title,
        summary: "",
        url: canonical.href,
        image: safeUrl(item.socialimage),
        publishedAt: new Date(published).toISOString(),
        source: org,
        topic: "vietnam",
        headline: false,
        appearances: [{ source: org, url: canonical.href }],
        language: item.language === "English" ? "en" : "vi",
        region: "vietnam",
        wire: true,
        // publisher vs discovery stay separate: source=org, GDELT is only
        // the discovery provider — never the author of the document
        ingest: {
          sourceKind: "publisher",
          discoveredVia: "gdelt",
          discoveryProvider: GDELT_SOURCE_NAME,
          sourceDomain: host,
        },
      });
    }
    return {
      articles,
      status: {
        ...statusBase,
        latencyMs: Date.now() - t0,
        status: articles.length ? "ok" : "empty",
        count: articles.length,
      },
    };
  } catch (error) {
    // fail-open: rate limits and timeouts degrade the source, never the cycle
    const msg = error instanceof Error ? error.message : "Fetch failed";
    const rateLimited = /429/.test(msg);
    return {
      articles: [],
      status: {
        ...statusBase,
        latencyMs: Date.now() - t0,
        httpStatus: rateLimited ? 429 : undefined,
        status: rateLimited ? "rate_limited" : "error",
        count: 0,
        error: msg.slice(0, 140),
      },
    };
  }
}

/** Fetch all feeds (bounded concurrency) + Hacker News, deduplicated. */
export async function fetchAllNews(): Promise<RawNews> {
  const results: Awaited<ReturnType<typeof fetchFeed>>[] = [];
  for (let i = 0; i < feeds.length; i += CONCURRENCY)
    results.push(
      ...(await Promise.all(feeds.slice(i, i + CONCURRENCY).map(fetchFeed))),
    );
  const [hnArticles, gdelt, congbao, secEdgar] = await Promise.all([
    fetchHackerNews(),
    fetchGdelt(),
    fetchCongBao(),
    fetchSecEdgar(),
  ]);
  const rawArticles = results
    .flatMap((result) => result.articles)
    .concat(hnArticles, gdelt.articles, congbao.articles, secEdgar.articles);
  const articles = deduplicate(rawArticles);
  const sources = results.map((result) => result.status);
  sources.push(gdelt.status, congbao.status, secEdgar.status);
  if (hnArticles.length > 0) {
    sources.unshift({
      id: "hacker-news",
      name: "Hacker News",
      topic: "technology",
      url: "https://news.ycombinator.com",
      status: "ok",
      count: hnArticles.length,
      checkedAt: new Date().toISOString(),
    });
  }
  return { articles, sources, fetchedAt: new Date().toISOString() };
}
