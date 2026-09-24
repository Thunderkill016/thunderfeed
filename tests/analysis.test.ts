import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCluster,
  buildTimeline,
  deterministicNhanDinh,
  framingDiff,
} from "../lib/analysis";
import {
  clusterArticles,
  isDomesticSource,
  mergeClustersBySimilarity,
} from "../lib/cluster";
import { isGroundedNhanDinh, extractNumbers } from "../lib/gemini";
import type { Article, StoryCluster } from "../lib/model";

function art(over: Partial<Article>): Article {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    title: over.title ?? "Tiêu đề thử nghiệm",
    summary: over.summary ?? "",
    url: over.url ?? `https://example.com/${Math.random()}`,
    image: null,
    publishedAt: over.publishedAt ?? new Date().toISOString(),
    source: over.source ?? "VnExpress",
    topic: over.topic ?? "world",
    headline: over.headline ?? false,
    appearances: over.appearances ?? [
      { source: over.source ?? "VnExpress", url: over.url ?? "https://x.vn" },
    ],
    language: over.language ?? "vi",
    region: over.region,
    wire: over.wire,
  };
}

test("clusters same event across sources into one cluster", () => {
  const articles = [
    art({
      source: "VnExpress",
      title: "Ông Trump phát biểu tại Đại hội đồng LHQ về xung đột Iran",
      summary: "Tổng thống Mỹ đưa ra thông điệp về Iran và Ukraine",
      topic: "world",
    }),
    art({
      source: "BBC World News",
      title: "Trump addresses UN General Assembly on Iran conflict",
      summary: "US president spoke about Iran, Ukraine and AI",
      topic: "world",
      language: "en",
    }),
    art({
      source: "The Guardian",
      title: "Trump UN speech: Iran and Ukraine dominate address",
      summary: "Key messages on Iran conflict from the president",
      topic: "world",
      language: "en",
    }),
    art({
      source: "VietnamNet",
      title: "Mưa lớn gây ngập tại Hà Nội sáng nay",
      summary: "Ngập cục bộ nhiều tuyến đường",
      topic: "vietnam",
    }),
  ];
  const clusters = clusterArticles(articles);
  const trump = clusters.find(
    (c) => c.title.includes("Trump") || c.title.includes("trump"),
  );
  assert.ok(trump, "expected a Trump cluster");
  assert.ok(trump!.sources.length >= 2, "cluster merges multiple sources");
  assert.ok(
    clusters.some((c) => c.leadArticle.source === "VietnamNet"),
    "unrelated story stays separate",
  );
});

test("spectrum marks international-only blindspot", () => {
  const articles = [
    art({
      source: "BBC World News",
      title: "Oil pipeline disruption hits Red Sea shipping routes",
      summary: "Houthi attacks disrupt the pipeline corridor",
      language: "en",
      region: "world",
    }),
    art({
      source: "Al Jazeera",
      title: "Red Sea oil pipeline disruption widens amid Houthi conflict",
      summary: "Shipping routes face disruption in the Red Sea",
      language: "en",
      region: "world",
    }),
  ];
  const clusters = clusterArticles(articles);
  const c = clusters[0];
  assert.ok(c.mediaSpectrum);
  assert.equal(c.mediaSpectrum!.internationalCount >= 2, true);
  assert.equal(c.blindspot, "international-only");
});

test("domestic source detection covers VN outlets", () => {
  assert.equal(isDomesticSource("VnExpress"), true);
  assert.equal(isDomesticSource("Nhân Dân"), true);
  assert.equal(isDomesticSource("VietnamPlus"), true);
  assert.equal(isDomesticSource("BBC World News"), false);
  assert.equal(isDomesticSource("The Guardian"), false);
});

test("deterministic nhận định is grounded in cluster signals", () => {
  const articles = [
    art({
      source: "VnExpress",
      title: "Fed giữ nguyên lãi suất, GDP tăng 6,5%",
      summary: "Lãi suất giữ nguyên theo kỳ vọng",
      topic: "business",
    }),
    art({
      source: "VietnamNet",
      title: "Fed giữ nguyên lãi suất mới, GDP tăng 6,5%",
      summary: "Lãi suất không đổi trong kỳ này",
      topic: "business",
    }),
    art({
      source: "Nikkei Asia",
      title: "Fed holds rates steady as GDP rises 6.5%",
      summary: "Rates unchanged per expectations",
      topic: "business",
      language: "en",
    }),
  ];
  const cluster = clusterArticles(articles)[0];
  const nd = deterministicNhanDinh(cluster);
  assert.equal(nd.origin, "deterministic");
  assert.ok(nd.text.length > 60);
  assert.ok(nd.watchItems.length >= 2);
  // numbers mentioned must be traceable: source count
  assert.ok(nd.text.includes(`${cluster.sources.length}`));
});

test("analysis exposes ownership spectrum on VN policy events", () => {
  const articles = [
    art({
      source: "Nhân Dân",
      title: "Quốc hội thông qua nghị quyết về quy hoạch đường sắt Hà Nội",
      summary: "Nghị quyết quy hoạch mới được thông qua tại Quốc hội",
      topic: "vietnam",
    }),
    art({
      source: "Báo Chính Phủ",
      title: "Nghị quyết quy hoạch đường sắt Hà Nội được Quốc hội thông qua",
      summary: "Quốc hội thông qua quy hoạch đường sắt mới",
      topic: "vietnam",
    }),
  ];
  const cluster = clusterArticles(articles)[0];
  assert.equal(cluster.ownership!.stateCount, 2);
  assert.equal(cluster.strategicDomain, "national_policy");
  const analysis = analyzeCluster(cluster);
  assert.ok(analysis.nhanDinh.text.length > 0);
  assert.ok(analysis.headlines.every((h) => h.ownerType));
});

test("gemini grounding rejects ungrounded numbers and advice", () => {
  const allowed = new Set([6.5, 3]);
  assert.equal(
    isGroundedNhanDinh(
      "Sự kiện được 3 tòa soạn đưa tin và đáng chú ý vì GDP tăng 6,5%. Độ phủ cao cho thấy đây là diễn biến quan trọng cần theo dõi.",
      allowed,
    ),
    true,
  );
  assert.equal(
    isGroundedNhanDinh(
      "Sự kiện này sẽ đẩy giá lên 99% trong tuần tới chắc chắn.",
      allowed,
    ),
    false,
  );
  assert.equal(
    isGroundedNhanDinh(
      "Nhà đầu tư nên mua vào ngay lúc này vì cơ hội lớn.",
      allowed,
    ),
    false,
  );
});

test("extractNumbers parses vi + en numeric forms", () => {
  assert.deepEqual(extractNumbers("GDP tăng 6,5% với 1.250 tỷ"), [6.5, 1250]);
  assert.deepEqual(extractNumbers("up 3.5% to 1,250"), [3.5, 1250]);
});

test("framingDiff surfaces each side's distinctive wording", () => {
  const cluster = {
    id: "c1",
    articles: [
      art({
        source: "VnExpress",
        title: "Việt Nam kiên quyết phản đối trung chuyển hàng hóa",
      }),
      art({
        source: "Tuổi Trẻ",
        title: "Hàng xuất khẩu trung chuyển bị siết chặt kiểm soát",
      }),
      art({
        source: "BBC World News",
        title: "Vietnam rejects transshipment claims amid tariff talks",
      }),
      art({
        source: "The Guardian",
        title: "Hanoi pushes back on transshipment tariff dispute",
      }),
    ],
  } as unknown as StoryCluster;
  const diff = framingDiff(cluster);
  assert.ok(diff.domestic.length > 0, "domestic side has distinctive terms");
  assert.ok(diff.international.length > 0, "intl side has distinctive terms");
  // transshipment only appears on the intl side
  assert.ok(
    diff.international.some((t) => t.toLowerCase().includes("transshipment")),
  );
  // no overlap between the two sides
  for (const t of diff.domestic) assert.ok(!diff.international.includes(t));
});

test("framingDiff returns empty when one side lacks material", () => {
  const cluster = {
    id: "c2",
    articles: [
      art({ source: "VnExpress", title: "Tin trong nước một" }),
      art({ source: "BBC World News", title: "International story one" }),
    ],
  } as unknown as StoryCluster;
  const diff = framingDiff(cluster);
  assert.deepEqual(diff, { domestic: [], international: [] });
});

test("buildTimeline orders sources by first publish with lag", () => {
  const t0 = "2026-09-24T01:00:00Z";
  const cluster = {
    id: "c3",
    articles: [
      art({ source: "Late Source", publishedAt: "2026-09-24T03:30:00Z" }),
      art({ source: "First Source", publishedAt: t0 }),
      art({ source: "Late Source", publishedAt: "2026-09-24T04:00:00Z" }),
      art({ source: "Mid Source", publishedAt: "2026-09-24T02:00:00Z" }),
    ],
  } as unknown as StoryCluster;
  const tl = buildTimeline(cluster);
  assert.equal(tl[0].source, "First Source");
  assert.equal(tl[0].lagHours, 0);
  // earliest article per source wins — Late Source lags 2.5h, not 3h
  assert.equal(tl[2].source, "Late Source");
  assert.equal(tl[2].lagHours, 2.5);
});

test("deterministic nhận định varies opening across clusters", () => {
  const texts = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const cluster = {
      ...clusterArticles([
        art({
          source: `S${i}a`,
          title: `Sự kiện thử nghiệm số ${i} về kinh tế`,
        }),
        art({
          source: `S${i}b`,
          title: `Sự kiện thử nghiệm số ${i} kinh tế lớn`,
        }),
        art({
          source: `S${i}c`,
          title: `Sự kiện thử nghiệm ${i} kinh tế phát triển`,
        }),
        art({
          source: `S${i}d`,
          title: `Sự kiện ${i} kinh tế phát triển mạnh`,
        }),
      ])[0],
      id: `cluster-${i}`,
    };
    texts.add(deterministicNhanDinh(cluster).text.split("—")[0]);
  }
  assert.ok(texts.size > 1, "openings should vary across cluster ids");
});

// Semantic merge: vi/en paraphrases share entity_vietnam but no vocabulary —
// lexical clustering must keep them apart, embeddings must join them.
// Semantic merge: vi/en paraphrases share entity_vietnam but no vocabulary —
// lexical clustering must keep them apart, embeddings must join them.
function paraphrasePair() {
  return [
    art({
      source: "VnExpress",
      title: "Việt Nam ký thỏa thuận hợp tác chiến lược với đối tác nước ngoài",
      topic: "world",
      language: "vi",
    }),
    art({
      source: "Reuters",
      title: "Vietnam inks strategic partnership deal with foreign partner",
      topic: "world",
      language: "en",
    }),
  ];
}

test("lexical clustering keeps vi/en paraphrases apart", () => {
  const clusters = clusterArticles(paraphrasePair());
  assert.equal(clusters.length, 2);
});

test("mergeClustersBySimilarity joins paraphrased clusters", () => {
  const lexical = clusterArticles(paraphrasePair());
  const strong = mergeClustersBySimilarity(lexical, () => 0.9);
  assert.equal(strong.length, 1);
  assert.equal(strong[0].articles.length, 2);
  // merged cluster recomputes spectrum across both languages
  assert.equal(strong[0].mediaSpectrum?.internationalCount, 1);
  assert.equal(strong[0].mediaSpectrum?.domesticCount, 1);
});

test("anchored merge needs ≥2 shared entities below the strong band", () => {
  // each clustered separately: article-level lexical rules can't pre-merge
  // them here, so the cluster-level anchored band is what fires
  const [cx] = clusterArticles([
    art({
      source: "VnExpress",
      title: "Việt Nam ký thỏa thuận hợp tác chiến lược với Mỹ",
      topic: "world",
      language: "vi",
    }),
  ]);
  const [cy] = clusterArticles([
    art({
      source: "Reuters",
      title: "Vietnam inks strategic partnership deal with the United States",
      topic: "world",
      language: "en",
    }),
  ]);
  // entity_vietnam + entity_us shared on both sides → anchored merge at 0.78
  const anchored = mergeClustersBySimilarity([cx, cy], () => 0.78);
  assert.equal(anchored.length, 1);

  // a single shared entity is not enough at that band
  const [sa] = clusterArticles([
    art({
      source: "VnExpress",
      title: "Việt Nam ký thỏa thuận hợp tác chiến lược với đối tác nước ngoài",
      topic: "world",
      language: "vi",
    }),
  ]);
  const [sb] = clusterArticles([
    art({
      source: "Reuters",
      title: "Vietnam inks strategic partnership deal with foreign partner",
      topic: "world",
      language: "en",
    }),
  ]);
  const unmerged = mergeClustersBySimilarity([sa, sb], () => 0.78);
  assert.equal(unmerged.length, 2);
});

test("weak semantic similarity does not merge", () => {
  const lexical = clusterArticles(paraphrasePair());
  const merged = mergeClustersBySimilarity(lexical, () => 0.5);
  assert.equal(merged.length, 2);
});

function _types(_c: StoryCluster) {}
