export const topics = [
  { id: "world", label: "Thế giới", color: "#256a9a" },
  { id: "vietnam", label: "Việt Nam", color: "#b64838" },
  { id: "business", label: "Kinh tế", color: "#997427" },
  { id: "technology", label: "Công nghệ", color: "#7859a6" },
  { id: "science", label: "Khoa học", color: "#337b72" },
  { id: "health", label: "Sức khỏe", color: "#b7587b" },
  { id: "sports", label: "Thể thao", color: "#568143" },
  { id: "culture", label: "Giải trí", color: "#ae6843" },
  { id: "life", label: "Đời sống", color: "#798036" },
  { id: "travel", label: "Du lịch", color: "#3b8f9a" },
  { id: "education", label: "Giáo dục", color: "#77674d" },
] as const;
export type Topic = (typeof topics)[number]["id"];
export const topicById = new Map(topics.map((t) => [t.id, t]));

/**
 * Relative age anchored to a fixed reference (the edition snapshot) so SSR
 * and client hydration render identical strings — never call Date.now() in
 * render paths.
 */
export function timeAgo(iso: string, nowMs: number, compact = false): string {
  const h = (nowMs - Date.parse(iso)) / 3_600_000;
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return compact ? `${m}p` : `${m} phút trước`;
  }
  if (h < 24)
    return compact ? `${Math.round(h)}h` : `${Math.round(h)} giờ trước`;
  const d = Math.round(h / 24);
  return compact ? `${d}d` : `${d} ngày trước`;
}

export type Article = {
  id: string;
  title: string;
  summary: string;
  url: string;
  image: string | null;
  publishedAt: string;
  source: string;
  topic: Topic;
  headline: boolean;
  appearances: { source: string; url: string }[];
  language?: "vi" | "en";
  region?: "world" | "vietnam" | "asia" | "europe" | "us" | "tech";
  wire?: boolean;
  /** provenance of THIS observation — set by fetcher, consumed by persist */
  ingest?: import("./ingest").IngestMetadata;
};

export type SourceStatusKind =
  "ok" | "empty" | "rate_limited" | "timeout" | "error";

export type SourceStatus = {
  id: string;
  name: string;
  topic: Topic;
  url: string;
  status: SourceStatusKind;
  count: number;
  checkedAt: string;
  latencyMs?: number;
  httpStatus?: number;
  retryAfter?: string;
  error?: string;
};

/* ------------------------------- clusters -------------------------------- */

export type StrategicDomain =
  "geopolitics" | "economy" | "frontier_tech" | "national_policy" | "general";

export type SourceRef = {
  name: string;
  url: string;
  language?: "vi" | "en";
  angle?: string;
};

export interface MediaSpectrum {
  totalSources: number;
  internationalCount: number;
  domesticCount: number;
  internationalPct: number;
  domesticPct: number;
  internationalSources: string[];
  domesticSources: string[];
}

export interface OwnershipSpectrum {
  /** State-owned/state-funded vs private/independent outlets in the cluster. */
  stateCount: number;
  privateCount: number;
  unknownCount: number;
  stateSources: string[];
  privateSources: string[];
}

export interface ByTheNumbersFact {
  label: string;
  value: string;
  context: string;
}

/* ------------------------- temporal tracking ----------------------------- */

/** Cross-edition story movement, computed from persisted cluster state. */
export type MomentumPhase = "emerging" | "accelerating" | "steady" | "cooling";

export interface Momentum {
  phase: MomentumPhase;
  /** articles that joined since the previous edition snapshot */
  newArticles: number;
  /** sources that joined since the previous edition snapshot */
  newSources: string[];
  firstSeen: string;
}

/** Distinctive terms each side uses for the same event (framing diff). */
export interface FramingDiff {
  domestic: string[];
  international: string[];
}

/** Who reported first — propagation order across the cluster's sources. */
export interface SourceTiming {
  source: string;
  publishedAt: string;
  /** hours after the earliest source in the cluster */
  lagHours: number;
  isDomestic: boolean;
}

/* ------------------------- claim-level analysis -------------------------- */

/** A factual point stated by ≥2 sources in the cluster. */
export interface ConsensusPoint {
  point: string;
  sources: string[];
}

/** A topic where sources assert materially different facts or framings. */
export interface ClaimDispute {
  topic: string;
  positions: { source: string; claim: string }[];
}

/** Grounded claim matrix: what sources agree on vs. where they diverge. */
export interface ClaimAnalysis {
  consensus: ConsensusPoint[];
  disputes: ClaimDispute[];
  origin: "gemini";
  model?: string;
}

export type StoryCluster = {
  id: string;
  title: string;
  summary: string;
  leadArticle: Article;
  articles: Article[];
  sources: SourceRef[];
  topic: Topic;
  scope: "world" | "vietnam" | "tech" | "business" | "science";
  significanceScore: number;
  publishedAt: string;
  isBreaking?: boolean;
  strategicDomain?: StrategicDomain;
  keyTakeaways?: string[];
  readingTimeMin?: number;
  mediaSpectrum?: MediaSpectrum;
  ownership?: OwnershipSpectrum;
  byTheNumbers?: ByTheNumbersFact[];
  /** true when every source is domestic OR every source is international. */
  blindspot?: "domestic-only" | "international-only";
  /** cross-edition momentum — set by lib/tracking.ts */
  momentum?: Momentum;
};

/* ------------------------------ nhận định -------------------------------- */

export interface NhanDinh {
  /** 2–4 câu nhận định — generated or deterministic. */
  text: string;
  /** Bullet watch items. */
  watchItems: string[];
  /** "gemini" | "deterministic" — provenance is part of the product. */
  origin: "gemini" | "deterministic";
  model?: string;
}

export interface EventAnalysis {
  nhanDinh: NhanDinh;
  theNews: string;
  whyItMatters: string;
  theViewFrom: {
    source: string;
    summary: string;
    url?: string;
    isDomestic?: boolean;
    ownerType?: string;
  }[];
  spectrum: MediaSpectrum;
  ownership: OwnershipSpectrum;
  byTheNumbers: ByTheNumbersFact[];
  headlines: {
    source: string;
    title: string;
    url: string;
    isDomestic: boolean;
    ownerType?: string;
  }[];
  /** distinctive wording per side — the framing comparison */
  framing: FramingDiff;
  /** sources sorted by earliest publish — the propagation order */
  timeline: SourceTiming[];
  /** claim-level agreement/disagreement — absent without a grounded LLM pass */
  claims?: ClaimAnalysis;
}

export type PillarId = "geopolitics" | "economy" | "tech" | "vietnam";

export interface Pillar {
  id: PillarId;
  label: string;
  events: StoryCluster[];
}

export interface Edition {
  /** Serialized payload served to the client. */
  hero: StoryCluster | null;
  heroAnalysis: EventAnalysis | null;
  pillars: Pillar[];
  /** events flagged blindspot, grouped */
  blindspots: {
    internationalOnly: StoryCluster[];
    domesticOnly: StoryCluster[];
  };
  analyses: Record<string, EventAnalysis>;
  wire: Article[];
  trending: { term: string; count: number }[];
  sources: SourceStatus[];
  updatedAt: string | null;
  stale: boolean;
  llmEnabled: boolean;
  totalArticles: number;
  /** diff vs the previous edition snapshot */
  changes: { newEvents: number; accelerating: number };
  /**
   * cluster.id → canonical event id, when the evidence layer persisted
   * this edition. Lets the UI open the EventView for any rendered card.
   */
  eventIds?: Record<string, string>;
}

/* -------------------------------- helpers -------------------------------- */

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tokenizer stop words for deterministic clustering (ported from diem-tin).
const STOP_WORDS = new Set([
  "va",
  "cua",
  "trong",
  "cho",
  "voi",
  "nhung",
  "cac",
  "mot",
  "nhieu",
  "duoc",
  "khong",
  "ngay",
  "nam",
  "khi",
  "theo",
  "ve",
  "tai",
  "den",
  "la",
  "ra",
  "vao",
  "tren",
  "duoi",
  "sau",
  "truoc",
  "giua",
  "dong",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "have",
  "has",
  "over",
  "after",
  "into",
  "more",
  "will",
  "about",
  "been",
  "says",
  "said",
  "near",
  "what",
  "how",
  "why",
  "who",
  "when",
  "where",
  "viet",
  "nam",
  "nguoi",
  "dan",
  "biet",
  "dang",
  "cung",
  "nhu",
  "lai",
  "se",
  "chi",
  "co",
  "di",
  "lam",
  "len",
  "xuong",
  "chieu",
  "sang",
  "toi",
  "hom",
  "qua",
  "nay",
  "gio",
  "phut",
  "giay",
  "tuan",
  "thang",
  "moi",
  "nhat",
  "noi",
  "quan",
  "doi",
  "thanh",
  "nien",
  "nuoc",
  "tong",
  "chu",
  "tich",
  "tinh",
  "tp",
  "huyen",
  "xa",
  "phuong",
  "ong",
  "ba",
  "anh",
  "chi",
  "em",
  "hai",
  "bon",
  "bay",
  "tam",
  "chin",
  "muoi",
  "tram",
  "nghin",
  "trieu",
  "ty",
  "vu",
  "tan",
  "cong",
  "nan",
  "su",
  "kien",
  "chinh",
  "quyen",
  "khang",
  "dinh",
  "thong",
  "tin",
  "bao",
  "hop",
  "phat",
  "bieu",
  "nghi",
  "ngo",
  "deu",
  "rat",
  "vi",
  "do",
  "nen",
  "neu",
  "thi",
  "ma",
  "hay",
  "hoac",
]);
export { STOP_WORDS };

// Noise pattern ported from diem-tin: trivia/gossip/petty-crime/recipes etc.
const NOISE_PATTERN =
  /\b(nuoc nao la|cau do|trac nghiem|trong \d+ giay|tung uu dai|khuyen mai|giam gia|voucher|lo dien|chuyen tinh|hon nhan|danh ghen|ngoai tinh|trom cap|chuyen phong the|lo anh|tu vi|boi toan|con giap|van han|phong thuy|meo vat|luoc ga|nau an|cong thuc|am thuc|quan an|banh mi|banh cuon|meo lam dep|giam can|duong da|va cham giao thong|xe may va cham|tai nan giao thong|xe khach|xe tai lat|tong xe|danh nhau|trom cho|cuop giat|nhay cau|duoi nuoc|nuoc cuon|mat tich|chet duoi|thi the|xac chet|tu tu|chay nha|hoa hoan|boc hoa|chay quan|chay xuong|chay rung|chay cho|chay chung cu|mua lon|sam set|ngap ung|trieu cuong|giong loc|loc xoay|mu bao hiem|danh ban|ngo doc|thuc pham|thuc an|nhap vien|tam giam|khoi to|bat giu|trieu tap|phat tien|linh an|showbiz|sao viet|hoa hau|a hau|nguoi mau|dien vien|ca si|scandal|lo clip|hen ho|ly hon|chia tay|dam cuoi|uong nuoc|dau lung|ung thu vi|xet nghiem|bai thuoc|con vat la|bat duoc tran|ca la|ran doc|giet nguoi|dung dao|dung dien|mau thuan ban nha|oc huong|chet bat thuong|xe volvo|lo luy ke)\b/i;

/** Vietnamese display label for a media typology value. Client-safe: keep
 * this pure — never import mediaData.ts (it bundles the JSON registry). */
export function typologyLabel(typology: string): string {
  switch (typology) {
    case "State Media":
    case "State Media / Digital":
      return "Báo nhà nước";
    case "State Funded Media":
      return "Nhà nước tài trợ";
    case "Public Media":
    case "Public Broadcaster":
    case "Public agency (statutory, editorially independent)":
      return "Đài/cơ quan công";
    case "Independent Media":
    case "Private Independent Media":
      return "Độc lập";
    case "Non-Profit":
      return "Phi lợi nhuận";
    case "Private Enterprise":
      return "Doanh nghiệp tư nhân";
    case "Private Media":
    case "Print Media":
    default:
      return "Tư nhân";
  }
}

export function isNoise(article: Article): boolean {
  const text = normalizeText(`${article.title} ${article.summary}`);
  const publicInterest =
    /\b(gia (thuc pham|dien|xang|gao)|an toan thuc pham|thu hoi (san pham|thuc pham)|canh bao (bao|lu|lu quet|thien tai)|so tan|bao hiem y te|hoc phi|luong toi thieu|tro cap|that nghiep|chi phi sinh hoat|lam phat|dich benh|ngap lut dien rong)\b/.test(
      text,
    );
  return !publicInterest && NOISE_PATTERN.test(text);
}
