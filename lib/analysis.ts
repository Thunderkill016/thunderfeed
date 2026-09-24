import { isDomesticSource } from "./cluster";
import { mediaInfoFor } from "./mediaData";
import {
  normalizeText,
  STOP_WORDS,
  type Article,
  type EventAnalysis,
  type FramingDiff,
  type NhanDinh,
  type SourceTiming,
  type StoryCluster,
} from "./model";

/**
 * Deterministic assessment generator — the analytical core of ThunderFeed.
 * Unlike diem-tin's fixed `whyItMatters` placeholder, this composes a real
 * nhận định from measurable signals: coverage momentum, domestic/international
 * asymmetry, ownership skew, extracted key figures, and domain context.
 * It never invents facts: every claim cites counts derived from the cluster.
 */

function hoursSince(iso: string): number {
  return Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} phút`;
  if (h < 24) return `${Math.round(h)} giờ`;
  return `${Math.round(h / 24)} ngày`;
}

function extractKeyFigure(cluster: StoryCluster): string | null {
  const text = `${cluster.title} ${cluster.leadArticle.summary}`;
  const m = text.match(
    /\b(\d+(?:[.,]\d+)?)\s*(triệu|tỷ|nghìn|%|usd|đô la|tấn|người|km|mw|năm|điểm)\b/i,
  );
  return m ? `${m[1]} ${m[2]}` : null;
}

const DOMAIN_CONTEXT: Record<string, string> = {
  geopolitics:
    "Đây là biến động địa chính trị — cần theo dõi phản ứng của các bên liên quan và rủi ro lan tỏa tới thương mại, năng lượng.",
  economy:
    "Đây là tín hiệu kinh tế — trọng tâm là tác động thực tế lên giá cả, doanh nghiệp và chính sách tiền tệ/thương mại.",
  frontier_tech:
    "Đây là diễn biến công nghệ đầu ngành — cần tách bạch tuyên bố marketing khỏi năng lực thực chứng và benchmark độc lập.",
  national_policy:
    "Đây là động thái chính sách trong nước — cần theo dõi văn bản triển khai, ai chịu tác động và mốc thời gian hiệu lực.",
  general:
    "Đây là sự kiện đáng chú ý trong ngày — cần kiểm chứng thêm quy mô, phạm vi ảnh hưởng và các nguồn độc lập.",
};

const DOMAIN_WATCH: Record<string, string[]> = {
  geopolitics: [
    "Phản ứng ngoại giao/quân sự của các bên trong 24–72h tới",
    "Tín hiệu từ các cơ quan LHQ, đồng minh hoặc đối tác chiến lược",
    "Tác động lên giá năng lượng, vận tải biển và chuỗi cung ứng",
  ],
  economy: [
    "Phản ứng của thị trường: tỷ giá, trái phiếu, chứng khoán ngành liên quan",
    "Động thái tiếp theo của cơ quan quản lý/ngân hàng trung ương",
    "Số liệu công bố kỳ tới xác nhận hay bác bỏ xu hướng",
  ],
  frontier_tech: [
    "Benchmark độc lập và phản ứng của các lab đối thủ",
    "Động thái pháp lý/quản lý đi kèm (an toàn, cấp phép, cạnh tranh)",
    "Mức độ áp dụng thực tế so với tuyên bố",
  ],
  national_policy: [
    "Nghị định/thông tư hướng dẫn và mốc hiệu lực",
    "Nhóm đối tượng chịu tác động trực tiếp và phản ứng địa phương",
    "Nguồn lực ngân sách và cơ quan chịu trách nhiệm triển khai",
  ],
  general: [
    "Xác nhận độc lập từ thêm nguồn trong 24h tới",
    "Quy mô và phạm vi ảnh hưởng thực tế",
    "Phát biểu chính thức của các bên liên quan",
  ],
};

/* ------------------------- framing + propagation ------------------------- */

/**
 * Distinctive words each side uses in titles for the same event — the
 * lexical framing signal. Only meaningful when both sides have material.
 */
export function framingDiff(cluster: StoryCluster): FramingDiff {
  const empty: FramingDiff = { domestic: [], international: [] };
  const dom = cluster.articles.filter((a) => isDomesticSource(a.source));
  const intl = cluster.articles.filter((a) => !isDomesticSource(a.source));
  if (dom.length < 2 || intl.length < 2) return empty;

  const count = (articles: Article[]) => {
    const freq = new Map<string, number>();
    const surface = new Map<string, string>();
    for (const a of articles) {
      for (const raw of a.title.split(/\s+/)) {
        const clean = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        const norm = normalizeText(clean);
        if (
          norm.length < 4 ||
          STOP_WORDS.has(norm) ||
          /^\d+$/.test(norm) ||
          norm.startsWith("entity_")
        )
          continue;
        freq.set(norm, (freq.get(norm) ?? 0) + 1);
        if (!surface.has(norm)) surface.set(norm, clean);
      }
    }
    return { freq, surface };
  };

  const pick = (
    side: ReturnType<typeof count>,
    other: ReturnType<typeof count>,
  ) =>
    [...side.freq.entries()]
      .filter(([w]) => !other.freq.has(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([w]) => side.surface.get(w) ?? w);

  const d = count(dom);
  const i = count(intl);
  return { domestic: pick(d, i), international: pick(i, d) };
}

/** Sources ordered by earliest article — who moved first, who followed. */
export function buildTimeline(cluster: StoryCluster): SourceTiming[] {
  const earliest = new Map<string, number>();
  for (const a of cluster.articles) {
    const t = Date.parse(a.publishedAt);
    const prev = earliest.get(a.source);
    if (prev === undefined || t < prev) earliest.set(a.source, t);
  }
  const rows = [...earliest.entries()].sort((a, b) => a[1] - b[1]);
  const t0 = rows[0]?.[1] ?? 0;
  return rows.map(([source, t]) => ({
    source,
    publishedAt: new Date(t).toISOString(),
    lagHours: Math.round(((t - t0) / 3_600_000) * 10) / 10,
    isDomestic: isDomesticSource(source),
  }));
}

/* ------------------------- nhận định templates --------------------------- */

/** Stable pick across editions — same cluster always gets the same voice. */
function pickVariant<T>(variants: T[], cluster: StoryCluster): T {
  let h = 0;
  for (const ch of cluster.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return variants[Math.abs(h) % variants.length];
}

const COVER_HIGH: ((n: number, h: string) => string)[] = [
  (n, h) =>
    `Sự kiện được ${n} tòa soạn đưa tin trong ${h} qua — mức độ phủ cao cho thấy đây là diễn biến định hình, không phải tin lẻ.`,
  (n, h) =>
    `${n} tòa soạn cùng đưa trong ${h} qua — độ phủ dày đặc cho thấy đây là diễn biến đáng theo dõi, không phải tin lẻ.`,
  (n, h) =>
    `Trong ${h} qua, ${n} tòa soạn đã đưa về sự kiện này — mức độ phủ như vậy thường chỉ xuất hiện ở các diễn biến định hình.`,
  (n, h) =>
    `Đây là một trong những sự kiện được đưa rộng nhất hiện tại: ${n} tòa soạn trong ${h} qua.`,
];

const COVER_MID: ((n: number, h: string) => string)[] = [
  (n, h) =>
    `Sự kiện được ${n} tòa soạn đưa tin trong ${h} qua — độ phủ vừa phải, cần thêm nguồn xác nhận.`,
  (n, h) =>
    `${n} tòa soạn đã đưa trong ${h} qua — độ phủ còn mỏng, câu chuyện có thể đang hình thành.`,
  (n, h) =>
    `Với ${n} tòa soạn đưa tin trong ${h} qua, sự kiện đã được xác nhận chéo nhưng quy mô thật cần thêm thời gian.`,
];

const COVER_LOW: ((n: number, h: string) => string)[] = [
  (n) =>
    `Hiện mới có ${n} nguồn đưa tin — thông tin còn ở mức ban đầu, chưa đủ căn cứ để kết luận.`,
  (n) =>
    `Chỉ ${n} nguồn duy nhất đưa tin — nên xem đây là thông tin một chiều, chờ xác nhận độc lập.`,
];

/** Deterministic nhận định — composed from cluster signals only. */
export function deterministicNhanDinh(cluster: StoryCluster): NhanDinh {
  const spectrum = cluster.mediaSpectrum;
  const sources = cluster.sources.length;
  const spanHours = hoursSince(cluster.publishedAt);
  const domain = cluster.strategicDomain ?? "general";
  const keyFigure = extractKeyFigure(cluster);

  const sentences: string[] = [];

  // 1. Coverage momentum — the measurable signal
  const cover =
    sources >= 4
      ? pickVariant(COVER_HIGH, cluster)
      : sources >= 2
        ? pickVariant(COVER_MID, cluster)
        : pickVariant(COVER_LOW, cluster);
  sentences.push(cover(sources, fmtHours(spanHours)));

  // 1b. Temporal momentum — new material since the last edition
  if (cluster.momentum?.phase === "accelerating") {
    const parts = [
      cluster.momentum.newArticles > 0
        ? `+${cluster.momentum.newArticles} bài`
        : null,
      cluster.momentum.newSources.length > 0
        ? `+${cluster.momentum.newSources.length} nguồn`
        : null,
    ].filter(Boolean);
    sentences.push(
      `Nhịp đưa tin đang tăng (${parts.join(", ")} so với bản trước) — sự kiện chưa khép lại.`,
    );
  } else if (cluster.momentum?.phase === "cooling") {
    sentences.push(
      `Không có bài mới kể từ bản trước — nhịp sự kiện đang hạ, trừ khi có diễn biến bổ sung.`,
    );
  }

  // 2. Coverage asymmetry — the Ground-News-style insight
  if (spectrum) {
    if (spectrum.domesticPct >= 75 && spectrum.totalSources >= 2) {
      sentences.push(
        `Độ phủ nghiêng hẳn về báo trong nước (${spectrum.domesticPct}%) — báo quốc tế chưa theo, nên bối cảnh toàn cầu của sự kiện có thể còn thiếu.`,
      );
    } else if (spectrum.internationalPct >= 75 && spectrum.totalSources >= 2) {
      sentences.push(
        `Độ phủ nghiêng về báo quốc tế (${spectrum.internationalPct}%) — báo trong nước chưa đưa hoặc đưa rất ít, độc giả VN dễ bỏ lỡ góc nhìn trong nước.`,
      );
    } else {
      sentences.push(
        `Cả báo trong nước và quốc tế cùng đưa (${spectrum.domesticPct}%/${spectrum.internationalPct}%) — có thể đối chiếu cách hai phía truyền thông định khung sự kiện.`,
      );
    }
  }

  // 3. Ownership skew on domestic stories — transparency signal
  if (cluster.ownership && cluster.ownership.stateCount > 0) {
    const total = cluster.ownership.stateCount + cluster.ownership.privateCount;
    if (
      total >= 2 &&
      cluster.ownership.stateCount / total >= 0.7 &&
      (cluster.scope === "vietnam" || domain === "national_policy")
    ) {
      sentences.push(
        `Phần lớn nguồn đưa tin là báo nhà nước (${cluster.ownership.stateCount}/${total}) — nên đối chiếu thêm góc nhìn tư nhân/độc lập nếu có.`,
      );
    }
  }

  // 4. Key figure + domain context
  if (keyFigure) {
    sentences.push(`Con số trọng yếu được ghi nhận: ${keyFigure}.`);
  }
  sentences.push(DOMAIN_CONTEXT[domain]);

  return {
    text: sentences.join(" "),
    watchItems: DOMAIN_WATCH[domain],
    origin: "deterministic",
  };
}

/** Full Semafor-style analysis of a cluster. */
export function analyzeCluster(
  cluster: StoryCluster,
  nhanDinh?: NhanDinh,
): EventAnalysis {
  const lead = cluster.leadArticle;
  const domain = cluster.strategicDomain || "general";

  const uniqueSources = new Map<string, { title: string; url: string }>();
  for (const a of cluster.articles) {
    if (!uniqueSources.has(a.source) && a.source !== lead.source) {
      uniqueSources.set(a.source, { title: a.title, url: a.url });
    }
    if (uniqueSources.size >= 5) break;
  }

  const theViewFrom: EventAnalysis["theViewFrom"] = [
    {
      source: lead.source,
      summary: lead.summary || lead.title,
      url: lead.url,
      isDomestic: isDomesticSource(lead.source),
      ownerType: mediaInfoFor(lead.source, lead.url)?.typology,
    },
    ...[...uniqueSources].map(([source, item]) => ({
      source,
      summary: item.title,
      url: item.url,
      isDomestic: isDomesticSource(source),
      ownerType: mediaInfoFor(source, item.url)?.typology,
    })),
  ];

  const headlines: EventAnalysis["headlines"] = [
    {
      source: lead.source,
      title: lead.title,
      url: lead.url,
      isDomestic: isDomesticSource(lead.source),
      ownerType: mediaInfoFor(lead.source, lead.url)?.typology,
    },
    ...[...uniqueSources].map(([source, item]) => ({
      source,
      title: item.title,
      url: item.url,
      isDomestic: isDomesticSource(source),
      ownerType: mediaInfoFor(source, item.url)?.typology,
    })),
  ];

  return {
    nhanDinh: nhanDinh ?? deterministicNhanDinh(cluster),
    theNews: lead.summary || lead.title,
    whyItMatters: DOMAIN_CONTEXT[domain],
    theViewFrom,
    spectrum: cluster.mediaSpectrum ?? {
      totalSources: cluster.sources.length,
      internationalCount: 0,
      domesticCount: cluster.sources.length,
      internationalPct: 0,
      domesticPct: 100,
      internationalSources: [],
      domesticSources: cluster.sources.map((s) => s.name),
    },
    ownership: cluster.ownership ?? {
      stateCount: 0,
      privateCount: 0,
      unknownCount: cluster.sources.length,
      stateSources: [],
      privateSources: [],
    },
    byTheNumbers: cluster.byTheNumbers ?? [],
    headlines,
    framing: framingDiff(cluster),
    timeline: buildTimeline(cluster),
  };
}
