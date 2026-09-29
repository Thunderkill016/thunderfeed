/* R7.1d.3a — reviewed attachment labels. Judgment unit = doc×event
 * (misclustering IS a doc-attachment error; the claim is downstream).
 * `foreign` = doc-title substrings whose story is NOT this event's.
 * A claim is `misclustered` iff every backing doc is foreign OR it has
 * no backing doc and its content names a foreign story. `driver` ids
 * come from the reviewed R7.1d.1d gold (driverClaimIds).
 *
 * Every misclustered claim also carries a `cause`, derived from corpus
 * provenance only (doc fan-out + event merge-path telemetry + title
 * language) — the four audit categories:
 *   extraction_wrong_grain      claim has no backing doc (manually
 *                               verified foreign via NF)
 *   multilingual_merge          all foreign docs cross-language and the
 *                               event shows an xlang merge path
 *   doc_cluster_contamination   every foreign doc attached ONLY here —
 *                               it rode in via this event's own cluster
 *   broad_event_reuse           at least one foreign doc is attached to
 *                               other events too — the resolver sprayed
 *                               it across umbrella events
 * Event-level `extraction_gap` = no surviving claim backed by an
 * on-story doc (the event's own docs may exist in event_evidence — the
 * gap is at claim extraction, which is why these events' materiality is
 * driven entirely by foreign claims). */
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
/* No-doc claims judged by content — claimId prefixes that name a
 * foreign story (e.g. Hormuz proposals inside the US-China event). */
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
  const causes: Record<string, string> = {};
  for (const cl of e.claims) {
    const docs = cl.evidence as any[];
    const noDocForeign = (keyFor(NF, e.eventId) ?? []).some((p) =>
      cl.claimId.startsWith(p),
    );
    const foreign =
      allForeign ||
      noDocForeign ||
      (docs.length > 0 && docs.every((d) => isForeign(d.docTitle)));
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
    const xlang =
      docs.length > 0 && docs.every((d) => lang(d.docTitle) !== lang(e.title));
    const hasXlangPath = Object.keys(e.mergePaths ?? {}).some((p) =>
      XLANG_PATHS.has(p),
    );
    const multiAttached = docs.some(
      (d) =>
        ((d.docEvents as any[]) ?? []).filter((x) => !x.detached).length > 1,
    );
    const cause = noDocForeign
      ? "extraction_wrong_grain"
      : xlang && hasXlangPath
        ? "multilingual_merge"
        : multiAttached
          ? "broad_event_reuse"
          : "doc_cluster_contamination";
    causes[cl.claimId] = cause;
    causeCounts[cause] = (causeCounts[cause] ?? 0) + 1;
  }
  // extraction gap = the event's story produced zero surviving claims:
  // every claim is misclustered. Derived, not hand-flagged.
  const vals = Object.values(claims);
  const gap = vals.length > 0 && vals.every((v) => v === "misclustered");
  if (gap) gapEvents.push(e.eventId);
  events.push({
    eventId: e.eventId,
    extractionGap: gap,
    mergePaths: e.mergePaths ?? {},
    claims,
    causes,
  });
}
const out = {
  generatedAt: new Date().toISOString(),
  corpusHash: corpus.claimIdsHash,
  classes: ["driver", "on_topic_non_driver", "misclustered"],
  causes: [
    "doc_cluster_contamination",
    "broad_event_reuse",
    "multilingual_merge",
    "extraction_wrong_grain",
  ],
  eventFlag: "extraction_gap",
  labelCount: Object.values(counts).reduce((a, b) => a + b, 0),
  counts,
  causeCounts,
  extractionGapEvents: gapEvents,
  events,
};
writeFileSync(
  "tests/fixtures/attachment-labels.json",
  JSON.stringify(out, null, 1),
);
console.log(counts, "gapEvents:", gapEvents.length);
