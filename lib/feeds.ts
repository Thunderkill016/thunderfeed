import type { DiscoveryChannel, SourceKind } from "./ingest";
import type { Topic } from "./model";

export type Feed = {
  id: string;
  name: string;
  topic: Topic;
  url: string;
  headline?: boolean;
  language?: "vi" | "en";
  region?: "world" | "vietnam" | "asia" | "europe" | "us" | "tech";
  wire?: boolean;
  /** feed omits item dates — stamp articles at fetch time (real-time wires) */
  undatedAsFresh?: boolean;
  /**
   * Non-RSS surface. "news-sitemap" is a Google News sitemap (<urlset> with
   * news:title + news:publication_date) — the only live machine-readable
   * output on outlets whose RSS died (RFA Tiếng Việt, CafeBiz, Người Đưa Tin).
   */
  format?: "news-sitemap";
  /** how we reach the document; default "rss" (or "news_sitemap" via format) */
  discovery?: DiscoveryChannel;
  /** publisher identity class; default "publisher" */
  sourceKind?: SourceKind;
  /** document_type for produced evidence; default "article" */
  documentType?: string;
  /** discovery-layer provider name (never the publisher) */
  discoveryProvider?: string;
  /** ISO-ish country for sources.country (primary sources, intl outlets) */
  country?: string;
};

const vne = (path: string, topic: Topic): Feed => ({
  id: `vne-${path}`,
  name: "VnExpress",
  topic,
  url: `https://vnexpress.net/rss/${path}.rss`,
  language: "vi",
  region: "vietnam",
});
const tt = (path: string, topic: Topic): Feed => ({
  id: `tt-${path}`,
  name: "Tuổi Trẻ",
  topic,
  url: `https://tuoitre.vn/rss/${path}.rss`,
  language: "vi",
  region: "vietnam",
});
const vnn = (path: string, topic: Topic): Feed => ({
  id: `vnn-${path}`,
  name: "VietnamNet",
  topic,
  url: `https://vietnamnet.vn/${path}.rss`,
  language: "vi",
  region: "vietnam",
});
const vnnews = (path: string, topic: Topic): Feed => ({
  id: `vnnews-${path}`,
  name: "Vietnam News",
  topic,
  url: `https://vietnamnews.vn/rss/${path}.rss`,
  language: "en",
  region: "vietnam",
});

const vov = (path: string, topic: Topic): Feed => ({
  id: `vov-${path}`,
  name: "VOV",
  topic,
  url: `https://vov.vn/rss/${path}.rss`,
  language: "vi",
  region: "vietnam",
});

/**
 * Curated feed registry. Vietnam section draws on the community-curated
 * kagisearch/kite-public `kite_feeds.json` (MIT, see data/KITE_LICENSE.txt);
 * international wires are the proven tier-1 set from diem-tin.
 */
export const feeds: Feed[] = [
  /* ------------------------- tier-1 world wires ------------------------- */
  {
    id: "bbc-vietnamese",
    name: "BBC News Tiếng Việt",
    topic: "world",
    url: "https://feeds.bbci.co.uk/vietnamese/rss.xml",
    headline: true,
    language: "vi",
    region: "world",
    wire: true,
  },
  {
    id: "bbc-world",
    name: "BBC World News",
    topic: "world",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    headline: true,
    language: "en",
    region: "world",
    wire: true,
  },
  {
    id: "guardian-world",
    name: "The Guardian",
    topic: "world",
    url: "https://www.theguardian.com/world/rss",
    language: "en",
    region: "world",
    wire: true,
  },
  {
    id: "aljazeera-world",
    name: "Al Jazeera",
    topic: "world",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    language: "en",
    region: "world",
    wire: true,
  },
  {
    id: "dw-world",
    name: "Deutsche Welle",
    topic: "world",
    url: "https://rss.dw.com/xml/rss-en-all",
    language: "en",
    region: "europe",
    wire: true,
  },
  {
    id: "france24-world",
    name: "France 24",
    topic: "world",
    url: "https://www.france24.com/en/rss",
    language: "en",
    region: "europe",
    wire: true,
  },
  {
    id: "nikkei-asia",
    name: "Nikkei Asia",
    topic: "world",
    url: "https://asia.nikkei.com/rss/feed/nar",
    language: "en",
    region: "asia",
    wire: true,
    undatedAsFresh: true,
  },
  {
    id: "asiatimes",
    name: "Asia Times",
    topic: "world",
    url: "https://asiatimes.com/feed/",
    language: "en",
    region: "asia",
  },
  {
    id: "thediplomat",
    name: "The Diplomat",
    topic: "world",
    url: "https://thediplomat.com/feed/",
    language: "en",
    region: "asia",
  },
  {
    id: "cna",
    name: "Channel News Asia",
    topic: "world",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
    language: "en",
    region: "asia",
  },
  {
    id: "scmp-asia",
    name: "South China Morning Post",
    topic: "world",
    url: "https://www.scmp.com/rss/91/feed",
    language: "en",
    region: "asia",
    wire: true,
  },
  {
    id: "st-asia",
    name: "The Straits Times",
    topic: "world",
    url: "https://www.straitstimes.com/news/asia/rss.xml",
    language: "en",
    region: "asia",
  },
  {
    id: "bangkokpost",
    name: "Bangkok Post",
    topic: "world",
    url: "https://www.bangkokpost.com/rss/data/topstories.xml",
    language: "en",
    region: "asia",
  },
  {
    id: "abc-au",
    name: "ABC News Australia",
    topic: "world",
    url: "https://www.abc.net.au/news/feed/51120/rss.xml",
    language: "en",
    region: "asia",
  },

  /* ----------------------------- US outlets ----------------------------- */
  {
    id: "nyt-world",
    name: "The New York Times",
    topic: "world",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    language: "en",
    region: "us",
    wire: true,
  },
  /* CNN is intentionally absent: rss.cnn.com still serves edition.rss but the
     channel froze in April 2023 — every machine-readable surface is stale. */
  {
    id: "fox-world",
    name: "Fox News",
    topic: "world",
    url: "https://moxie.foxnews.com/google-publisher/world.xml",
    language: "en",
    region: "us",
    wire: true,
  },
  {
    id: "npr-world",
    name: "NPR",
    topic: "world",
    url: "https://feeds.npr.org/1004/rss.xml",
    language: "en",
    region: "us",
    wire: true,
  },
  {
    id: "pbs-world",
    name: "PBS NewsHour",
    topic: "world",
    url: "https://www.pbs.org/newshour/feeds/rss/world",
    language: "en",
    region: "us",
  },
  {
    id: "thehill",
    name: "The Hill",
    topic: "world",
    url: "https://thehill.com/feed/",
    language: "en",
    region: "us",
  },
  {
    id: "cnbc",
    name: "CNBC",
    topic: "business",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    language: "en",
    region: "us",
  },

  /* ------------------------- Europe / Russia / Ukraine ------------------ */
  {
    id: "sky-world",
    name: "Sky News",
    topic: "world",
    url: "https://feeds.skynews.com/feeds/rss/world.xml",
    language: "en",
    region: "europe",
    wire: true,
  },
  {
    id: "independent",
    name: "The Independent",
    topic: "world",
    url: "https://www.independent.co.uk/rss",
    language: "en",
    region: "europe",
  },
  {
    id: "euronews",
    name: "Euronews",
    topic: "world",
    url: "https://www.euronews.com/rss",
    language: "en",
    region: "europe",
  },
  {
    id: "rt",
    name: "RT",
    topic: "world",
    url: "https://www.rt.com/rss/news/",
    language: "en",
    region: "europe",
  },
  {
    id: "tass",
    name: "TASS",
    topic: "world",
    url: "https://tass.com/rss/v2.xml",
    language: "en",
    region: "europe",
    wire: true,
  },
  {
    id: "moscowtimes",
    name: "The Moscow Times",
    topic: "world",
    url: "https://www.themoscowtimes.com/rss/news",
    language: "en",
    region: "europe",
  },
  {
    id: "ukrinform",
    name: "Ukrinform",
    topic: "world",
    url: "https://www.ukrinform.net/rss/block-lastnews",
    language: "en",
    region: "europe",
  },
  {
    id: "jpost",
    name: "The Jerusalem Post",
    topic: "world",
    url: "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
    language: "en",
    region: "world",
  },

  /* ------------------------- South / East Asia -------------------------- */
  {
    id: "toi",
    name: "The Times of India",
    topic: "world",
    url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
    language: "en",
    region: "asia",
    wire: true,
  },
  {
    id: "thehindu-intl",
    name: "The Hindu",
    topic: "world",
    url: "https://www.thehindu.com/news/international/feeder/default.rss",
    language: "en",
    region: "asia",
  },
  {
    id: "ndtv-world",
    name: "NDTV",
    topic: "world",
    url: "https://feeds.feedburner.com/ndtvnews-world-news",
    language: "en",
    region: "asia",
  },
  {
    id: "japantimes",
    name: "The Japan Times",
    topic: "world",
    url: "https://www.japantimes.co.jp/feed/",
    language: "en",
    region: "asia",
  },
  {
    id: "yonhap",
    name: "Yonhap News",
    topic: "world",
    url: "https://en.yna.co.kr/RSS/news.xml",
    language: "en",
    region: "asia",
  },
  {
    id: "cbc-world",
    name: "CBC News",
    topic: "world",
    url: "https://www.cbc.ca/cmlink/rss-world",
    language: "en",
    region: "world",
  },

  /* ---------------- primary sources: official publications ------------- */
  /* Federal Reserve — FOMC statements/press releases are primary evidence
     for rate/monetary claims; speeches/testimony are primary transcripts. */
  {
    id: "fed-press",
    name: "Federal Reserve",
    topic: "business",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    language: "en",
    region: "us",
    country: "US",
    sourceKind: "primary",
    discovery: "official_rss",
    documentType: "press_release",
  },
  {
    id: "fed-speeches",
    name: "Federal Reserve",
    topic: "business",
    url: "https://www.federalreserve.gov/feeds/speeches.xml",
    language: "en",
    region: "us",
    country: "US",
    sourceKind: "primary",
    discovery: "official_rss",
    documentType: "transcript",
  },
  {
    id: "fed-testimony",
    name: "Federal Reserve",
    topic: "business",
    url: "https://www.federalreserve.gov/feeds/testimony.xml",
    language: "en",
    region: "us",
    country: "US",
    sourceKind: "primary",
    discovery: "official_rss",
    documentType: "transcript",
  },

  /* --------- Vietnamese-language international (framing contrast) -------- */
  {
    id: "rfi-vi",
    name: "RFI Tiếng Việt",
    topic: "world",
    url: "https://www.rfi.fr/vi/rss",
    language: "vi",
    region: "world",
    wire: true,
  },
  {
    id: "rfa-en",
    name: "Radio Free Asia",
    topic: "world",
    url: "https://www.rfa.org/english/rss2.xml",
    language: "en",
    region: "asia",
    wire: true,
  },
  /* Google News sitemaps — only live machine-readable surface on outlets
     whose RSS died (RFA: USAGM cuts 2025; CafeBiz/Người Đưa Tin: RSS gone). */
  {
    id: "rfa-vi",
    name: "RFA Tiếng Việt",
    topic: "vietnam",
    url: "https://www.rfa.org/vietnamese/news-sitemap.xml",
    language: "vi",
    region: "world",
    wire: true,
    format: "news-sitemap",
  },
  {
    id: "cafebiz",
    name: "CafeBiz",
    topic: "business",
    url: "https://cafebiz.vn/google-news-sitemap.xml",
    language: "vi",
    region: "vietnam",
    format: "news-sitemap",
  },
  {
    id: "nguoiduatin",
    name: "Người Đưa Tin",
    topic: "vietnam",
    url: "https://www.nguoiduatin.vn/google-news-sitemap.xml",
    language: "vi",
    region: "vietnam",
    format: "news-sitemap",
  },

  /* ------------------------------ technology ---------------------------- */
  {
    id: "techmeme",
    name: "Techmeme",
    topic: "technology",
    url: "https://www.techmeme.com/feed.xml",
    headline: true,
    language: "en",
    region: "tech",
    wire: true,
  },
  {
    id: "theverge",
    name: "The Verge",
    topic: "technology",
    url: "https://www.theverge.com/rss/index.xml",
    language: "en",
    region: "tech",
  },
  {
    id: "arstechnica",
    name: "Ars Technica",
    topic: "technology",
    url: "https://arstechnica.com/feed/",
    language: "en",
    region: "tech",
  },

  /* ------------------------ Vietnam — thời sự --------------------------- */
  { ...vne("tin-noi-bat", "vietnam"), headline: true },
  vne("the-gioi", "world"),
  vne("thoi-su", "vietnam"),
  vne("phap-luat", "vietnam"),
  vne("giao-duc", "education"),
  { ...tt("thoi-su", "vietnam"), headline: true },
  tt("the-gioi", "world"),
  tt("phap-luat", "vietnam"),
  tt("giao-duc", "education"),
  { ...vnn("thoi-su", "vietnam"), headline: true },
  vnn("the-gioi", "world"),
  {
    id: "dantri-home",
    name: "Dân Trí",
    topic: "vietnam",
    url: "https://dantri.com.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "tienphong-home",
    name: "Tiền Phong",
    topic: "vietnam",
    url: "https://tienphong.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "vtv-home",
    name: "VTV",
    topic: "vietnam",
    url: "https://vtv.vn/rss/home.rss",
    headline: true,
    language: "vi",
    region: "vietnam",
  },
  vov("chinh-tri", "vietnam"),
  vov("xa-hoi", "vietnam"),
  vov("the-gioi", "world"),
  {
    id: "tn-home",
    name: "Thanh Niên",
    topic: "vietnam",
    url: "https://thanhnien.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },

  /* --------------------- Vietnam — nhà nước / wires --------------------- */
  {
    id: "nhandan-home",
    name: "Nhân Dân",
    topic: "vietnam",
    url: "https://nhandan.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "baochinhphu",
    name: "Báo Chính Phủ",
    topic: "vietnam",
    url: "https://baochinhphu.vn/rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "vietnamplus",
    name: "VietnamPlus",
    topic: "vietnam",
    url: "https://www.vietnamplus.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  vnnews("politics-laws", "vietnam"),
  vnnews("society", "vietnam"),
  /* English editions of VN outlets — the vi↔en bridge the resolver needs */
  {
    id: "vne-en",
    name: "e.VnExpress",
    topic: "vietnam",
    url: "https://e.vnexpress.net/rss/news.rss",
    language: "en",
    region: "vietnam",
  },
  {
    id: "vnplus-en",
    name: "VietnamPlus English",
    topic: "vietnam",
    url: "https://en.vietnamplus.vn/rss/home.rss",
    language: "en",
    region: "vietnam",
  },

  /* ------------------------------ kinh tế ------------------------------- */
  vne("kinh-doanh", "business"),
  tt("kinh-doanh", "business"),
  vnn("kinh-doanh", "business"),
  vnnews("economy", "business"),
  {
    id: "vneconomy",
    name: "VnEconomy",
    topic: "business",
    url: "https://en.vneconomy.vn/tin-moi.rss",
    language: "en",
    region: "vietnam",
  },
  {
    id: "vneconomy-vi",
    name: "VnEconomy",
    topic: "business",
    url: "https://vneconomy.vn/tin-moi.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "vir",
    name: "Vietnam Investment Review",
    topic: "business",
    url: "https://vir.com.vn/rss_feed/",
    language: "en",
    region: "vietnam",
  },
  {
    id: "vietcetera",
    name: "Vietcetera",
    topic: "business",
    url: "https://vietcetera.com/rss-vn.xml",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "cafef",
    name: "CafeF",
    topic: "business",
    url: "https://cafef.vn/home.rss",
    language: "vi",
    region: "vietnam",
  },

  /* -------------------- Vietnam — công nghệ/khoa học -------------------- */
  vne("khoa-hoc-cong-nghe", "technology"),
  vne("so-hoa", "technology"),
  tt("nhip-song-so", "technology"),
  tt("khoa-hoc", "science"),
  vne("khoa-hoc", "science"),
  {
    id: "tn-cong-nghe",
    name: "Thanh Niên",
    topic: "technology",
    url: "https://thanhnien.vn/rss/cong-nghe.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "tn-the-gioi",
    name: "Thanh Niên",
    topic: "world",
    url: "https://thanhnien.vn/rss/the-gioi.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "tn-thoi-su",
    name: "Thanh Niên",
    topic: "vietnam",
    url: "https://thanhnien.vn/rss/thoi-su.rss",
    language: "vi",
    region: "vietnam",
  },

  /* ------------------------- đời sống / khác ---------------------------- */
  vne("suc-khoe", "health"),
  vne("the-thao", "sports"),
  vne("giai-tri", "culture"),
  tt("the-thao", "sports"),
  tt("van-hoa", "culture"),
  {
    id: "kienthuc",
    name: "Kiến Thức",
    topic: "science",
    url: "https://kienthuc.net.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "skds-giadinh",
    name: "Sức khỏe & Đời sống",
    topic: "health",
    url: "https://giadinh.suckhoedoisong.vn/rss/home.rss",
    language: "vi",
    region: "vietnam",
  },
  {
    id: "tt247",
    name: "Thể Thao 247",
    topic: "sports",
    url: "https://thethao247.vn/the-thao-24h.rss",
    language: "vi",
    region: "vietnam",
  },
];
