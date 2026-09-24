import {
  isNoise,
  normalizeText,
  STOP_WORDS,
  type Article,
  type ByTheNumbersFact,
  type MediaSpectrum,
  type OwnershipSpectrum,
  type StoryCluster,
  type StrategicDomain,
} from "./model";
import { mediaInfoFor, ownershipClass } from "./mediaData";
import { injectEntityTokens } from "./entities";

export function classifyStrategicDomain(text: string): StrategicDomain {
  const norm = normalizeText(text);
  if (
    /\b(trump|zelensky|putin|brics|nato|eu|lien hop quoc|ngoai giao|tong bi thu|thu tuong|chu tich nuoc|doi tac chien luoc|tong thong|thuong dinh|dam phan|xung dot|ten lua|quan su|iran|israel|ukraine|trieu tien|houthi|yemen|bien do|red sea|saudi|arap xeut)\b/i.test(
      norm,
    )
  ) {
    return "geopolitics";
  }
  if (
    /\b(amodei|anthropic|openai|claude|nvidia|ban dan|tri tue nhan tao|mo hinh ai|hugging face|transformer|gemini|deepmind|robotics|quantum|apple intelligence|semiconductor|chips)\b/i.test(
      norm,
    )
  ) {
    return "frontier_tech";
  }
  if (
    /\b(thang du thuong mai|ngan hang trung uong|lai suat|lam phat|gdp|xuat khau|dau brent|vinfast|green sm|pham nhat vuong|chung khoan|trai phieu|fed|ty gia|fdi|duong ong|pipeline|xuat khau dau)\b/i.test(
      norm,
    )
  ) {
    return "economy";
  }
  if (
    /\b(cang nuoc sau|nha may dien|quy hoach|ho hoan kiem|ho guom|ha noi|tphcm|duong sat|san bay|chinh sach|nghi quyet|quoc hoi|luat dat dai|song hong|tai dinh cu)\b/i.test(
      norm,
    )
  ) {
    return "national_policy";
  }
  return "general";
}

function extractKeywords(text: string): Set<string> {
  const mapped = mapEntityAliases(text);
  const words = mapped.split(/\s+/);
  const keywords = new Set<string>();
  for (const word of words) {
    if (word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)) {
      keywords.add(word);
    }
  }
  return keywords;
}

/** Display names for entity_ tokens live in lib/entities.ts (entityLabel)
 *  — the gazetteer owns both matching and labeling so trending, the watch
 *  editor and alerts share one naming source. */

/**
 * Inject canonical entity_<slug> tokens into normalized text — the ONE
 * entity ontology (lib/entities.ts) shared with the persistent resolver.
 */
function mapEntityAliases(text: string): string {
  return injectEntityTokens(normalizeText(text));
}

function calculateSimilarity(
  tokensA: Set<string>,
  tokensB: Set<string>,
): number {
  if (!tokensA.size || !tokensB.size) return 0;
  let matches = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) matches++;
  }
  const union = tokensA.size + tokensB.size - matches;
  return union === 0 ? 0 : matches / union;
}

function generateKeyTakeaways(lead: Article, articles: Article[]): string[] {
  const points: string[] = [];
  if (lead.summary) {
    const firstSentence = lead.summary.split(/[.!?]\s+/)[0]?.trim();
    if (firstSentence && firstSentence.length > 20) {
      points.push(firstSentence);
    }
  }
  const otherSourceArticle = articles.find((a) => a.source !== lead.source);
  if (otherSourceArticle) {
    points.push(
      `Góc nhìn từ ${otherSourceArticle.source}: ${otherSourceArticle.title}`,
    );
  }
  return points.slice(0, 3);
}

export function extractBigrams(text: string): Set<string> {
  const mapped = mapEntityAliases(text);
  const words = mapped
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

export const DOMESTIC_SOURCES = new Set([
  "VnExpress",
  "Tuổi Trẻ",
  "Thanh Niên",
  "VietnamNet",
  "Dân Trí",
  "VietNam News",
  "Vietnam News",
  "Báo Đầu Tư",
  "Báo Giao Thông",
  "Nhân Dân",
  "Báo Chính Phủ",
  "VietnamPlus",
  "VnEconomy",
  "Vietnam Investment Review",
  "Vietcetera",
  "Tiền Phong",
  "Sức khỏe & Đời sống",
  "Kiến Thức",
]);

export function isDomesticSource(sourceName: string): boolean {
  if (DOMESTIC_SOURCES.has(sourceName)) return true;
  const info = mediaInfoFor(sourceName);
  if (info && info.country === "Vietnam") return true;
  const lower = sourceName.toLowerCase();
  return (
    lower.includes("việt nam") ||
    lower.includes("vietnam") ||
    lower.includes("tuổi trẻ") ||
    lower.includes("thanh niên") ||
    lower.includes("dân trí") ||
    lower.includes("sài gòn") ||
    lower.includes("saigon")
  );
}

export function calculateMediaSpectrum(
  sources: { name: string; language?: string }[],
): MediaSpectrum {
  const domesticSet = new Set<string>();
  const internationalSet = new Set<string>();

  for (const s of sources) {
    if (isDomesticSource(s.name)) {
      domesticSet.add(s.name);
    } else {
      internationalSet.add(s.name);
    }
  }

  const domesticCount = domesticSet.size;
  const internationalCount = internationalSet.size;
  const total = Math.max(1, domesticCount + internationalCount);
  const internationalPct = Math.round((internationalCount / total) * 100);
  const domesticPct = 100 - internationalPct;

  return {
    totalSources: total,
    internationalCount,
    domesticCount,
    internationalPct,
    domesticPct,
    internationalSources: Array.from(internationalSet),
    domesticSources: Array.from(domesticSet),
  };
}

/** State vs private ownership split across the cluster's sources. */
export function calculateOwnershipSpectrum(
  sources: { name: string; url?: string }[],
): OwnershipSpectrum {
  const stateSources: string[] = [];
  const privateSources: string[] = [];
  let unknownCount = 0;
  for (const s of sources) {
    const info = mediaInfoFor(s.name, s.url);
    const cls = info ? ownershipClass(info.typology) : "unknown";
    if (cls === "state") stateSources.push(s.name);
    else if (cls === "private") privateSources.push(s.name);
    else unknownCount++;
  }
  return {
    stateCount: stateSources.length,
    privateCount: privateSources.length,
    unknownCount,
    stateSources,
    privateSources,
  };
}

export function extractByTheNumbers(
  leadArticle: Article,
  clusterArticles: Article[],
  sourcesCount: number,
  domain: StrategicDomain | undefined,
  readingTimeMin: number,
): ByTheNumbersFact[] {
  const facts: ByTheNumbersFact[] = [];

  facts.push({
    label: "Độ phủ báo chí",
    value: `${sourcesCount}`,
    context: "Số tòa soạn độc lập đưa tin về sự kiện",
  });

  facts.push({
    label: "Thời gian đọc",
    value: `~${readingTimeMin} phút`,
    context: "Chắt lọc từ hàng chục nghìn chữ của các nguồn",
  });

  const fullText = `${leadArticle.title} ${leadArticle.summary} ${clusterArticles.map((a) => a.title).join(" ")}`;
  const metricMatch = fullText.match(
    /\b(\d+(?:[.,]\d+)?)\s*(triệu|tỷ|nghìn|%|usd|thùng|năm|người|km|mw|ha|héc ta|tấn|điểm)\b/i,
  );

  if (metricMatch) {
    facts.push({
      label: "Chỉ số trọng yếu",
      value: `${metricMatch[1]} ${metricMatch[2]}`,
      context: "Số liệu định lượng ghi nhận trực tiếp trong diễn biến",
    });
  } else if (domain === "geopolitics") {
    facts.push({
      label: "Cấp độ an ninh",
      value: "Cấp 1",
      context: "Rủi ro gián đoạn chuỗi cung ứng và huyết mạch năng lượng",
    });
  } else if (domain === "frontier_tech") {
    facts.push({
      label: "Cam kết mở",
      value: "Độc lập",
      context: "Tiêu chuẩn đánh giá an toàn mô hình AI từ bên thứ ba",
    });
  } else if (domain === "economy") {
    facts.push({
      label: "Tác động vĩ mô",
      value: "Trực tiếp",
      context: "Theo dõi dòng vốn và phản ứng thị trường tài chính",
    });
  } else {
    facts.push({
      label: "Độ ưu tiên",
      value: "Chiến lược",
      context: "Nằm trong các sự kiện định hình của bản tin",
    });
  }

  return facts;
}

/**
 * Cosine thresholds for the semantic merge path (injected embeddings).
 * News embeddings for the same event across languages typically land at
 * 0.75–0.9; unrelated stories on the same topic can still reach ~0.7, so
 * the lower threshold requires a shared entity anchor.
 */
export const SEMANTIC_MERGE_STRONG = 0.85;
export const SEMANTIC_MERGE_ANCHORED = 0.72;

/**
 * Derive every cluster field from its article set. Extracted so the semantic
 * merge pass can rebuild a merged cluster through the exact same path the
 * initial clustering uses.
 */
function finalizeCluster(clusterArticles: Article[]): StoryCluster {
  clusterArticles.sort((a, b) => {
    const aHeadline = a.headline ? 2 : 0;
    const bHeadline = b.headline ? 2 : 0;
    const aLen = a.summary.length;
    const bLen = b.summary.length;
    const languagePreference =
      Number(b.language === "vi") - Number(a.language === "vi");
    return (
      languagePreference || bHeadline + bLen / 1000 - (aHeadline + aLen / 1000)
    );
  });

  const leadArticle = clusterArticles[0];

  const sourcesMap = new Map<
    string,
    { name: string; url: string; language?: "vi" | "en"; angle?: string }
  >();
  for (const item of clusterArticles) {
    if (!sourcesMap.has(item.source)) {
      sourcesMap.set(item.source, {
        name: item.source,
        url: item.url,
        language: item.language,
        angle: item.title,
      });
    }
    for (const app of item.appearances) {
      if (!sourcesMap.has(app.source)) {
        sourcesMap.set(app.source, { name: app.source, url: app.url });
      }
    }
  }

  let scope: StoryCluster["scope"] = "world";
  if (leadArticle.topic === "vietnam") scope = "vietnam";
  else if (leadArticle.topic === "technology") scope = "tech";
  else if (leadArticle.topic === "business") scope = "business";
  else if (leadArticle.topic === "science") scope = "science";

  const strategicDomain = classifyStrategicDomain(
    `${leadArticle.title} ${leadArticle.summary}`,
  );

  const recencyHours =
    (Date.now() - Date.parse(leadArticle.publishedAt)) / 3_600_000;
  const recencyScore = Math.max(0, 48 - recencyHours);
  const clusterMultiplier = Math.min(60, clusterArticles.length * 15);
  const multiSourceBonus = sourcesMap.size > 1 ? (sourcesMap.size - 1) * 35 : 0;
  const headlineBonus = leadArticle.headline ? 15 : 0;
  const scopeBonus = ["world", "vietnam", "tech", "business"].includes(scope)
    ? 10
    : 0;

  let strategicBonus = 0;
  if (strategicDomain === "geopolitics") strategicBonus += 45;
  else if (strategicDomain === "frontier_tech") strategicBonus += 40;
  else if (strategicDomain === "economy") strategicBonus += 35;
  else if (strategicDomain === "national_policy") strategicBonus += 30;

  const significanceScore =
    recencyScore +
    clusterMultiplier +
    multiSourceBonus +
    headlineBonus +
    scopeBonus +
    strategicBonus;

  const keyTakeaways = generateKeyTakeaways(leadArticle, clusterArticles);
  const readingTimeMin = Math.max(
    2,
    Math.ceil(
      (leadArticle.title.length + leadArticle.summary.length * 3) / 400,
    ),
  );

  const sources = Array.from(sourcesMap.values());
  const mediaSpectrum = calculateMediaSpectrum(sources);
  const ownership = calculateOwnershipSpectrum(sources);
  const byTheNumbers = extractByTheNumbers(
    leadArticle,
    clusterArticles,
    sources.length,
    strategicDomain,
    readingTimeMin,
  );

  return {
    id: `cluster-${leadArticle.id}`,
    title: leadArticle.title,
    summary: leadArticle.summary,
    leadArticle,
    articles: clusterArticles,
    sources,
    topic: leadArticle.topic,
    scope,
    significanceScore,
    publishedAt: leadArticle.publishedAt,
    isBreaking:
      recencyHours <= 4 && (leadArticle.headline || sourcesMap.size > 1),
    strategicDomain,
    keyTakeaways,
    readingTimeMin,
    mediaSpectrum,
    ownership,
    byTheNumbers,
    blindspot:
      mediaSpectrum.domesticCount > 0 && mediaSpectrum.internationalCount === 0
        ? sources.length >= 2
          ? "domestic-only"
          : undefined
        : mediaSpectrum.internationalCount > 0 &&
            mediaSpectrum.domesticCount === 0
          ? sources.length >= 2
            ? "international-only"
            : undefined
          : undefined,
  };
}

/** Entity-alias tokens shared across the cluster's article titles. */
export function clusterEntities(c: StoryCluster): Set<string> {
  const ents = new Set<string>();
  for (const a of c.articles.slice(0, 8)) {
    for (const kw of extractKeywords(a.title)) {
      if (kw.startsWith("entity_")) ents.add(kw);
    }
  }
  return ents;
}

/** Representative text for embedding: lead title + a few source headlines. */
export function clusterRepText(c: StoryCluster): string {
  const titles = c.articles
    .slice(0, 4)
    .map((a) => a.title)
    .join(" | ");
  return `${c.title} | ${titles}`.slice(0, 700);
}

/**
 * Merge clusters whose embeddings say they are the same event. Pure: the
 * similarity function is injected so this is testable without the API.
 * Two bands — a strong cosine alone, or a moderate cosine plus ≥2 shared
 * entity anchors (single generic entities like entity_vietnam are too
 * common to anchor a merge on their own).
 */
export function mergeClustersBySimilarity(
  clusters: StoryCluster[],
  sim: (a: StoryCluster, b: StoryCluster) => number,
): StoryCluster[] {
  const parent = clusters.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const entities = clusters.map(clusterEntities);
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const s = sim(clusters[i], clusters[j]);
      if (s < SEMANTIC_MERGE_ANCHORED) continue;
      let shared = 0;
      for (const e of entities[i]) if (entities[j].has(e)) shared++;
      if (s >= SEMANTIC_MERGE_STRONG || shared >= 2) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, Article[]>();
  const order: number[] = [];
  clusters.forEach((c, i) => {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root)!.push(...c.articles);
  });
  return order.map((root) => {
    const arts = groups.get(root)!;
    const seen = new Set<string>();
    return finalizeCluster(
      arts.filter((a) => !seen.has(a.id) && seen.add(a.id)),
    );
  });
}

export function clusterArticles(articles: Article[]): StoryCluster[] {
  const clusters: StoryCluster[] = [];
  const assigned = new Set<string>();

  const candidates = articles.filter((a) => !isNoise(a));
  const pool = candidates.length >= 5 ? candidates : articles;

  const articleKeywords = new Map<string, Set<string>>();
  const articleBigrams = new Map<string, Set<string>>();
  for (const article of pool) {
    const isRoundup = /^tin tuc the gioi \d+/i.test(
      normalizeText(article.title),
    );
    const textToExtract = isRoundup
      ? article.title
      : `${article.title} ${article.summary}`;
    articleKeywords.set(article.id, extractKeywords(textToExtract));
    articleBigrams.set(article.id, extractBigrams(article.title));
  }

  for (let i = 0; i < pool.length; i++) {
    const current = pool[i];
    if (assigned.has(current.id)) continue;

    const clusterArticles: Article[] = [current];
    assigned.add(current.id);
    const currentKeywords = articleKeywords.get(current.id)!;
    const currentBigrams = articleBigrams.get(current.id)!;
    const currentTime = Date.parse(current.publishedAt);

    for (let j = i + 1; j < pool.length; j++) {
      const other = pool[j];
      if (assigned.has(other.id)) continue;

      const otherTime = Date.parse(other.publishedAt);
      if (Math.abs(currentTime - otherTime) > 48 * 3_600_000) continue;

      const otherKeywords = articleKeywords.get(other.id)!;
      const otherBigrams = articleBigrams.get(other.id)!;
      const sim = calculateSimilarity(currentKeywords, otherKeywords);

      let sharedBigrams = 0;
      for (const bg of currentBigrams) {
        if (otherBigrams.has(bg)) sharedBigrams++;
      }

      let sharedEntities = 0;
      for (const kw of currentKeywords) {
        if (kw.startsWith("entity_") && otherKeywords.has(kw)) sharedEntities++;
      }

      const isSameStory =
        sharedEntities >= 2 ||
        sim >= 0.4 ||
        (sharedBigrams >= 1 && sim >= 0.26) ||
        (sharedEntities >= 1 && sharedBigrams >= 1 && sim >= 0.18);

      if (isSameStory) {
        clusterArticles.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(finalizeCluster(clusterArticles));
  }

  return clusters.sort((a, b) => b.significanceScore - a.significanceScore);
}
