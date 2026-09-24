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
];
