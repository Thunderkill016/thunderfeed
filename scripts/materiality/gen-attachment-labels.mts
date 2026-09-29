/* R7.1d.3a.1 — reviewed attachment labels on STANDING-EVIDENCE grain.
 * Judgment unit = doc×event (misclustering IS a doc-attachment error;
 * the claim is downstream). `foreign` = doc-title substrings whose
 * story is NOT this event's. A claim is `misclustered` iff every
 * STANDING-backing doc is foreign OR it has no standing doc and its
 * content names a foreign story. `driver` ids come from the reviewed
 * R7.1d.1d gold (driverClaimIds).
 *
 * Every misclustered claim also carries a `causeProxy` +
 * `causeConfidence`. PROXIES ONLY — resolver telemetry is
 * cluster→event grain, so nothing here proves doc-level causality:
 *   doc_cluster_contamination   every foreign doc attached ONLY to this
 *                               event (strong_proxy — doc-level signal)
 *   broad_event_reuse           ≥1 foreign doc attached to other live
 *                               events too (strong_proxy — doc-level)
 *   multilingual_merge          foreign docs are cross-language AND the
 *                               event shows an xlang merge path
 *                               (weak_proxy — needs event-level path)
 *   extraction_wrong_grain      claim has no standing doc at all —
 *                               nothing currently backs it (weak_proxy)
 *
 * Event-level `extraction_gap` requires BOTH (audit-frozen invariant):
 *   1. ≥1 reviewed on-story event doc — ONSTORY[event] doc-id prefixes,
 *      verified live (non-detached) in eventEvidence
 *   2. zero surviving on-story claims — every claim misclustered
 * An all-misclustered event with no reviewed on-story doc is NOT a gap
 * (fully-foreign contamination event) — ONSTORY must list it explicitly
 * (empty array = "reviewed: no on-story doc") or generation aborts. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const corpus = JSON.parse(
  readFileSync("tests/fixtures/attachment-corpus.json", "utf8"),
);
const gold = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-labels.json", "utf8"),
).labels as any[];
const goldDrivers = new Map<string, Set<string>>(
  gold
    .filter((g) => g.driversReviewed && g.driverClaimIds)
    .map((g) => [g.eventId, new Set<string>(g.driverClaimIds)]),
);

/* Foreign doc titles per event (substring match, case-folded).
 * Belongs-by-default: anything not listed stays on-story. */
const F: Record<string, string[]> = {
  // ── giant: US-China summit ──
  "01a0d176-5a20": [
    "costa rica",
    "groenland",
    "đại dịch",
    "ukraina",
    "ukraine",
    "zelensky",
    "putin",
    "g20",
    "iran",
    "hormuz",
    "uber",
    "wayve",
    "bangkok",
    "asiad",
    "fort trump",
    "vodafone",
    "si - siêu trí tuệ",
    "máy nhắn tin",
    "colombia",
    "ả rập",
    "yemen",
    "tesla",
    "tiết kiệm nhiên liệu",
    "không quân",
    "jellycat",
    "slimming",
    "hươu",
    "graciela",
    "palestine",
    "nepal",
    "chứng khoán châu á",
    "canada",
    "tô lâm",
    "chỉ được, không thiệt",
  ],
  // OpenAI agent Australia — all docs on-topic
  "01a0d176-5aac": [],
  // Tin tức thế giới Nga-Greenland: najib doc foreign
  "01a0d176-5af1": ["najib"],
  // Xi arrives / red carpet — belongs: visit docs; foreign list:
  "01a0d176-5b1c": [
    "bão nolo",
    "board of peace",
    "gaza",
    "super intelligence",
    "fed hạ lãi",
    "shrimp",
    "tôm",
    "tầm ruột",
    "uber",
    "costa rica",
    "si - siêu",
    "greenland",
    "palestine",
  ],
  // VN 1.3M peacekeeping budget — foreign property-case doc
  "01a0d176-5b29": ["ngôi nhà bán"],
  "01a0d176-5b5d": ["hong kong exports"],
  "01a0d176-5ba4": [], // Zelensky-Trump doc on-topic
  "01a0d176-5bcd": [], // VN upgrade capital flows — no claims anyway
  "01a0d176-5be3": [], // GFDI — on-topic
  "01a0d176-5c17": [], // Weinstein — on-topic
  // Board of Peace $2.45B Gaza reconstruction
  "01a0d176-5c4d": [
    "costa rica",
    "chỉ được",
    "iran",
    "fed hạ lãi",
    "super intelligence",
    "si - siêu",
    "nepal",
    "lương tam quang",
    "blackrock",
    "putin",
    "zelensky",
    "uae",
    "cia",
    "patriot",
    "vệ binh",
    "pakistan",
    "rahman",
    "sarandon",
    "netanyahu",
    "tây ban nha",
    "hội đồng bảo an",
    "hong kong",
    "food outlets",
    "gaza documentary",
    "diễn đàn lhq",
    "delegates walk out",
    "bỏ ra ngoài",
    "máy nhắn tin",
  ],
  // Iran 5-day Hormuz ultimatum
  "01a0d176-5d58": [
    "810 triệu",
    "đại dịch",
    "ukraina",
    "fort trump",
    "ba lan",
    "bangkok",
    "tiết kiệm nhiên liệu",
    "hiền thục",
    "ice",
    "trung quốc",
    "tariff",
    "30 tỷ",
    "30bn",
    "thuế quan",
  ],
  "01a0d176-5de4": ["nepal", "lũ quét"], // Spain UNSC reform
  "01a0d176-5e1f": ["poverty"], // Argentina-UN: poverty-rate doc foreign
  // ── Tô Lâm 'no transshipment' ──
  "01a0d188-7dc2": [
    "triển lãm",
    "vietjet",
    "starlink",
    "chứng khoán",
    "vinhomes",
    "vnpt",
    "qualcomm",
    "đồ ăn",
    "quốc hội canada",
    "sinh viên",
    "chữa cháy",
  ],
  // US $430M dioxin Biên Hòa — every doc foreign + extraction gap
  "01a0d188-812a": [
    "gìn giữ hòa bình",
    "máy xúc",
    "thị trường vốn",
    "chữa cháy",
    "canada",
  ],
  "01a0d188-895c": [], // ADB 7.8% — on-topic
  // ── Kiev missile strike giant ──
  "01a0d3a9-e534": [
    "chuyển lậu",
    "tiktok",
    "hormuz",
    "iran",
    "pháp",
    "saudi",
    "putin",
    "g20",
    "palestine",
    "brazil",
    "najib",
    "tô lâm",
    "trump",
    "marie",
    "fort trump",
    "tehran",
  ],
  // Vietjet-Starlink
  "01a0d3a9-fa8d": ["lottery", "xổ số", "dầu diesel", "diesel"],
  // Trump-Xi B-1 flyover / expressions event
  "01a0d3aa-015a": [
    "groenland",
    "iran",
    "hormuz",
    "asiad",
    "bóng bàn",
    "điền kinh",
    "bóng chuyền",
    "sầu riêng",
    "uber",
    "wayve",
    "costa rica",
    "funding",
    "bond yields",
    "bsr",
    "exxonmobil",
    "iowa",
    "tass",
    "si - siêu",
    "chứng khoán châu á",
    "nữ việt nam",
    "xăng dầu",
    "zelensky",
    "patriot",
    "collins",
  ],
  // Tô Lâm Canada state visit
  "01a0d3aa-1e1f": [
    "netanyahu",
    "israel",
    "nepal",
    "bệnh nhi",
    "lương hoàng thái",
    "trung tâm tài chính",
    "openai",
    "diesel",
    "lhq",
  ],
  // Xi red-carpet composite event
  "01a0d3aa-33dd": [
    "uber",
    "wayve",
    "groenland",
    "iran",
    "ngừng bắn",
    "jellycat",
    "sân vận động",
    "úc giúp",
    "chứng khoán",
    "tehran",
  ],
  "01a0d45b": ["lưới điện", "2 tỷ"], // diesel EU: US-grid doc foreign
  "01a0d4ed": ["*"], // CNN docs attached but produced no surviving claim
  // VN-Canada trade
  "01a0d705": [
    "infographic",
    "thai nguyen",
    "a330",
    "hàng cấm",
    "brics",
    "nissan",
    "asiad",
    "đại học",
    "trung tâm tài chính",
    "vạn xuân",
    "nepal",
    "điện hạt nhân",
  ],
  "01a0d788": ["liên ngân hàng", "lãi suất liên"], // gold-price event, bank-liquidity doc foreign
  "01a0d789": ["fifa", "asiad", "thần đồng", "kim sang sik", "philippines"], // VN-Malaysia trade
  "01a0d828": [], // oil + Houthi Saudi — on-topic
  // US-Iran Hormuz roadmap
  "01a0d851": ["mỹ-iraq", "iraq chuyển"],
  // semiconductor workforce
  "01a0d87d": [
    "chứng khoán",
    "dung quất",
    "canada",
    "vinhomes",
    "robot maker",
    "tiến sĩ",
    "triển lãm",
    "mỏ dầu",
    "tô lâm",
  ],
  "01a0d905": ["*"], // 4 Colombia-break docs attached, 0 claims survived
  "01a0dc10": ["*"], // A330 docs attached, no surviving claim
  "01a0dc3c": ["*"], // on-story docs attached, no surviving claim
  // Black Sea grain-supply video digest — Ukraine-war docs on-topic
  "01a0dd9e": ["palestine", "hormuz", "iran"],
  // US-Iraq pivot
  "01a0de40": ["netanyahu", "lhq", "blacklist", "nepal", "israel"],
  // OpenAI attacks gov sites
  "01a0dede": ["trung tâm tài chính", "ngoại giao", "bản lĩnh ngoại giao"],
  "01a0def9": ["*"], // founding doc attached, no surviving claim
  // HCMC 5.7B industrial zones
  "01a0e182": ["trung tâm tài chính", "fta", "xuất khẩu sang"],
  // rice trade decree
  "01a0e1ab": ["tngt", "hải phòng tập trung"],
  "01a0e257": ["*"], // FPT doc attached, no surviving claim
  // Swiss neutrality referendum
  "01a0e25c": [
    "nhật tân",
    "zelensky",
    "uav",
    "unsc",
    "security council",
    "tin tức",
    "steel plant",
    "nga, đức",
    "ukraine",
    "putin",
  ],
  // Iran distrust — Ukraine-war docs foreign
  "01a0e2aa": [
    "zelensky",
    "uav",
    "ukraine",
    "kiev",
    "starlink",
    "donetsk",
    "nga, đức",
    "cầu đường sắt",
    "155 tỷ",
    "hàn quốc",
    "hàn river",
    "slimming",
    "du lịch",
    "fairford",
    "6,6 tỷ",
    "12 tỷ",
  ],
  // VN global security cooperation — surviving claims all from Ukraine docs
  "01a0e335": ["*"], // on-story doc attached, no surviving claim
  "01a0e572": [], // US poverty — on-topic
  // panda diplomacy — summit-outcome docs foreign to THIS event
  "01a0e755": [
    "tariff",
    "thuế quan",
    "30 tỷ",
    "30bn",
    "$30",
    "60 tỷ",
    "coal",
    "than ",
    "đường dây nóng",
    "sự cố ai",
    "tham vấn",
    "đình chiến",
    "hưu chiến",
    "europe",
    "tám điểm",
    "8 điểm",
    "kết quả",
  ],
  "01a0e769": ["*"], // 4 Ban Chỉ đạo 57 docs attached, no surviving claim
  "01a0e8f9": ["*"], // SHB doc attached, no surviving claim
};

// normalized lookup: foreign patterns keyed by event id prefix
/* Claims whose CONTENT names a foreign story — manually verified.
 * Overrides doc-provenance when a claim's union evidence includes an
 * on-story doc but the claim itself is off-story (e.g. "arrests 100"
 * NY-protest claim inside the Board-of-Peace event). */
const NF: Record<string, string[]> = {
  "01a0d176-5a20": [
    "01a0d787-6140",
    "01a0d8f2-a3af",
    "01a0d914-baa2",
    "01a0dccb-1d04",
    "01a0ddbe-21ae",
    "01a0dddc-472e",
    "01a0de38-e13e",
    "01a0decc-1291",
    "01a0e073-ba6e",
  ],
  "01a0d176-5b1c": ["01a0d4fd-1f51"],
  "01a0d176-5b29": ["01a0d188-861c"],
  "01a0d176-5be3": ["01a0d17a-9aec"],
  "01a0d176-5c4d": ["01a0d556-0f1a", "01a0d7c9-d1db"],
  "01a0d176-5de4": ["01a0d4be-35e8"],
  "01a0d188-7dc2": ["01a0d3e3-4ef0"],
  "01a0d188-812a": ["01a0d188-819c"],
  "01a0d3a9-e534": ["01a0d7c7-276f"],
  "01a0d3aa-015a": ["01a0db9f-aa49", "01a0db9f-ae85", "01a0dbe9-583c"],
  "01a0d87d-635f": ["01a0d8d4-95c0"],
  "01a0e25c-a5c6": ["01a0e3f3-f85e", "01a0e3f4-054f"],
  "01a0e2aa-dc8e": ["01a0e35b-e891", "01a0e3c4-8465"],
};

/* Reviewed on-story eventEvidence doc-id prefixes per all-misclustered
 * event — the docs that ARE this event's story (they exist in
 * event_evidence but produced zero surviving claims → extraction gap).
 * Empty array = "reviewed: event has NO on-story doc" (fully-foreign
 * contamination event, NOT a gap). Missing key on an all-misclustered
 * event aborts generation — the review is mandatory, never inferred. */
const ONSTORY: Record<string, string[]> = {
  // Tin tức Thế giới digest — its own digest doc attached
  "01a0d176-5af1": ["01a0d176-5aea"],
  // F-35 Hong Kong — founding + follow-up docs attached
  "01a0d176-5b5d": ["01a0d176-5b53", "01a0d176-5b56", "01a0d176-5b59"],
  // Spain UNSC reform — founding doc attached
  "01a0d176-5de4": ["01a0d176-5de0"],
  // Argentina-UN Falklands — founding doc attached
  "01a0d176-5e1f": ["01a0d176-5e15"],
  // dioxin Biên Hòa — founding doc attached under 297 sprayed docs
  "01a0d188-812a": ["01a0d188-7f9c"],
  // White House CNN access — press-access docs attached
  "01a0d4ed-0a02": [
    "01a0d4e6-e903",
    "01a0d4e6-e908",
    "01a0d4e6-e912",
    "01a0d46d-8319",
    "01a0d3a5-8166",
    "01a0dc47-8256",
    "01a0dfb4-2610",
    "01a0dbe6-9e0c",
  ],
  // gold-price 1-week low — founding doc attached
  "01a0d788-fa78": ["01a0d788-f9c8"],
  // Colombia-Iran severance — 4 on-story docs among 181 Hormuz docs
  "01a0d905-4143": [
    "01a0d846-7d9b",
    "01a0d704-e052",
    "01a0d905-35b8",
    "01a0d704-e102",
  ],
  // A330 ferry flight — founding doc attached
  "01a0dc10-2dd3": ["01a0db1f-1365"],
  // Burnham Labour — founding doc attached
  "01a0dc3c-a3e1": ["01a0dc3c-839d"],
  // Palestine candidate list — founding doc attached
  "01a0def9-6ee3": ["01a0decc-914a"],
  // FPT strategic-tech talent — founding doc attached
  "01a0e257-82a7": ["01a0e18b-a2fe"],
  // global security cooperation — founding doc attached
  "01a0e335-42c9": ["01a0e2a4-46fc"],
  // Ban Chỉ đạo 57 econ-social session — econ-social docs attached
  // (the committee's sci-tech session docs are a different meeting)
  "01a0e769-b127": ["01a0e769-9c5a", "01a0e769-a948", "01a0e7e3-456b"],
  // SHB import-export finance — founding doc attached
  "01a0e8f9-d4b1": ["01a0e854-a7c1"],
};

const keyFor = <T,>(m: Record<string, T>, eventId: string): T | undefined => {
  for (const [pfx, v] of Object.entries(m))
    if (eventId.startsWith(pfx)) return v;
  return undefined;
};
const foreignFor = (eventId: string) => keyFor(F, eventId);

/* Vietnamese titles carry diacritics; anything without them is treated
 * as en. Diagnostic only — feeds cause annotation, never the label. */
const VI =
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const lang = (t?: string | null) => (t && VI.test(t) ? "vi" : "en");
const XLANG_PATHS = new Set(["cross_lingual", "semantic_xlang"]);

const events: any[] = [];
const counts = { driver: 0, on_topic_non_driver: 0, misclustered: 0 };
const causeCounts: Record<string, number> = {};
const gapEvents: string[] = [];
const fullyForeign: string[] = [];
for (const e of corpus.events as any[]) {
  const pats = foreignFor(e.eventId);
  if (pats === undefined) {
    console.error("UNLABELED EVENT:", e.eventId, e.title);
    process.exit(1);
  }
  const allForeign = pats.includes("*");
  const isForeign = (title: string) =>
    allForeign ||
    pats.some((p) => title.toLowerCase().includes(p.toLowerCase()));
  const drivers = goldDrivers.get(e.eventId) ?? new Set<string>();
  const claims: Record<string, string> = {};
  const causeProxies: Record<string, string> = {};
  const causeConfidence: Record<string, string> = {};
  for (const cl of e.claims) {
    /* standing evidence only — docs behind latest-per-origin votes on
     * the standing position (all claim_versions, shared accessor). A
     * voter that moved off the standing position no longer backs it. */
    const docs = cl.standingEvidence as any[];
    const noDocForeign = (keyFor(NF, e.eventId) ?? []).some((p) =>
      cl.claimId.startsWith(p),
    );
    const foreign =
      allForeign ||
      noDocForeign ||
      (docs.length > 0 && docs.every((d) => isForeign(d.title)));
    if (!foreign) {
      if (drivers.has(cl.claimId)) {
        claims[cl.claimId] = "driver";
        counts.driver++;
      } else {
        claims[cl.claimId] = "on_topic_non_driver";
        counts.on_topic_non_driver++;
      }
      continue;
    }
    claims[cl.claimId] = "misclustered";
    counts.misclustered++;
    // cause PROXY derives from the foreign docs backing the claim.
    // Doc-level signals (fanout, single-attach) are strong proxies;
    // anything needing event-level merge-path telemetry is weak —
    // nothing here proves doc-level causality (needs R7.1d.3b.1).
    const foreignDocs = docs.filter((d) => isForeign(d.title));
    const xlang =
      foreignDocs.length > 0 &&
      foreignDocs.every((d) => lang(d.title) !== lang(e.title));
    const hasXlangPath = Object.keys(e.mergePaths ?? {}).some((p) =>
      XLANG_PATHS.has(p),
    );
    const multiAttached = foreignDocs.some(
      (d) => (d.activeEvents as string[]).length > 1,
    );
    const [proxy, conf] =
      docs.length === 0
        ? (["extraction_wrong_grain", "weak_proxy"] as const)
        : xlang && hasXlangPath
          ? (["multilingual_merge", "weak_proxy"] as const)
          : multiAttached
            ? (["broad_event_reuse", "strong_proxy"] as const)
            : (["doc_cluster_contamination", "strong_proxy"] as const);
    causeProxies[cl.claimId] = proxy;
    causeConfidence[cl.claimId] = conf;
    causeCounts[proxy] = (causeCounts[proxy] ?? 0) + 1;
  }
  /* extraction_gap invariant — BOTH sides must hold:
   *   1. ≥1 reviewed on-story event doc, verified live in eventEvidence
   *   2. zero surviving on-story claims (every claim misclustered)
   * An all-misclustered event without a reviewed on-story doc is
   * fully-foreign contamination, not an extraction gap. */
  const vals = Object.values(claims);
  const allMis = vals.length > 0 && vals.every((v) => v === "misclustered");
  let onStoryDocIds: string[] | undefined;
  if (allMis) {
    onStoryDocIds = keyFor(ONSTORY, e.eventId);
    if (onStoryDocIds === undefined) {
      console.error(
        "ALL-MISCLUSTERED EVENT WITHOUT ONSTORY REVIEW:",
        e.eventId,
        e.title,
      );
      process.exit(1);
    }
  }
  const onStoryDocs = (e.eventEvidence as any[]).filter(
    (d) =>
      !d.detached &&
      (onStoryDocIds ?? []).some((p) => d.documentId.startsWith(p)),
  );
  // every listed prefix must resolve — a dead prefix means stale review
  for (const p of onStoryDocIds ?? [])
    if (!onStoryDocs.some((d) => d.documentId.startsWith(p))) {
      console.error("ONSTORY prefix unmatched:", e.eventId, p);
      process.exit(1);
    }
  const gap = allMis && onStoryDocs.length > 0;
  if (gap) gapEvents.push(e.eventId);
  else if (allMis) fullyForeign.push(e.eventId);
  events.push({
    eventId: e.eventId,
    extractionGap: gap,
    fullyForeign: !gap && allMis,
    mergePaths: e.mergePaths ?? {},
    onStoryEventEvidence: onStoryDocs.map((d) => ({
      documentId: d.documentId,
      evidenceVersionId: d.evidenceVersionId,
      title: d.title,
    })),
    claims,
    causeProxies,
    causeConfidence,
  });
}
const out = {
  generatedAt: new Date().toISOString(),
  corpusHash: corpus.corpusHash,
  classes: ["driver", "on_topic_non_driver", "misclustered"],
  causeProxies: [
    "doc_cluster_contamination",
    "broad_event_reuse",
    "multilingual_merge",
    "extraction_wrong_grain",
  ],
  causeConfidences: ["strong_proxy", "weak_proxy"],
  eventFlag: "extraction_gap",
  labelCount: Object.values(counts).reduce((a, b) => a + b, 0),
  counts,
  causeCounts,
  extractionGapEvents: gapEvents,
  fullyForeignEvents: fullyForeign,
  events,
};
writeFileSync(
  "tests/fixtures/attachment-labels.json",
  JSON.stringify(out, null, 1),
);
console.log(counts, "gapEvents:", gapEvents.length);
