/**
 * Generates bench/lineage.jsonl — hand-labeled lineage corpus.
 * Categories per spec: wire copies, attribution, independent same-fact,
 * primary→publisher, publisher→local rewrite, cross-language copy,
 * same-publisher articles, similar wording different event.
 * Run: npx tsx scripts/bench/gen-lineage.ts > bench/lineage.jsonl
 */
import type { LineageDoc } from "../../lib/lineage";

const T0 = "2026-09-24T08:00:00Z";
const at = (min: number) =>
  new Date(Date.parse(T0) + min * 60_000).toISOString();

let n = 0;
const cases: unknown[] = [];
const doc = (
  source: string,
  title: string,
  summary: string,
  min: number,
  opts: Partial<LineageDoc> = {},
): LineageDoc => ({
  documentId: `doc-${source.replace(/\W/g, "")}-${n}-${opts.url ?? "x"}`,
  source,
  title,
  summary,
  publishedAt: at(min),
  url: opts.url ?? `https://x.vn/${++n}`,
  language: opts.language ?? "vi",
  sourceKind: opts.sourceKind,
});

const add = (
  label: string,
  child: LineageDoc,
  candidates: LineageDoc[],
  note?: string,
) => cases.push({ id: `c${++n}`, label, note, child, candidates });

/* ------------------- A. same wire copy (×12) ------------------- */
const wireTitle = "Bão lớn: 20 chuyến bay bị hủy";
const wireSum =
  "Bão lớn đổ bộ khiến 20 chuyến bay bị hủy, hàng nghìn hành khách " +
  "mắc kẹt tại các sân bay trong khu vực.";
const wireEn = {
  t: "Major storm grounds travel — 20 flights cancelled",
  s: "A major storm made landfall Tuesday, forcing airlines to cancel 20 flights and stranding thousands of passengers across the region.",
};
const reuters = doc("Reuters", wireEn.t, wireEn.s, -60, { language: "en" });
const afp = doc(
  "AFP",
  "20 flights cancelled as storm makes landfall",
  wireEn.s,
  -45,
  { language: "en" },
);

// vi verbatim copies of the vi wire
for (let i = 0; i < 6; i++) {
  add(
    "syndicated",
    doc(`Báo ${i + 1}`, wireTitle, wireSum, i * 5),
    [doc("TTXVN", wireTitle, wireSum, -30)],
    "verbatim vi copy",
  );
}
// en near-verbatim copies
for (let i = 0; i < 4; i++) {
  add(
    "syndicated",
    doc(`Site${i}`, wireEn.t, wireEn.s, i * 7, { language: "en" }),
    [reuters],
    "verbatim en copy",
  );
}
// near-verbatim with minor edits — still wire
add(
  "syndicated",
  doc(
    "LocalNews",
    "Bão lớn: 20 chuyến bay bị hủy tại các sân bay",
    wireSum + " Chi tiết đang được cập nhật.",
    20,
  ),
  [doc("TTXVN", wireTitle, wireSum, -30)],
  "minor edit wire copy",
);
add(
  "syndicated",
  doc("Daily", wireEn.t, wireEn.s.slice(0, 120), 15, { language: "en" }),
  [reuters, afp],
  "truncated wire copy",
);

/* ------------------- B. explicit attribution (×8) ------------------- */
const attrPool = [reuters, afp];
const attrCases: [string, string, string, string][] = [
  ["VnExpress", "Theo Reuters: bão lớn khiến 20 chuyến bay bị hủy", "Theo Reuters đưa tin, bão lớn đã khiến 20 chuyến bay bị hủy trong khu vực.", "theo Reuters"],
  ["Tuổi Trẻ", "Reuters cho biết 20 chuyến bay bị hủy vì bão", "Reuters cho biết hãng hàng không đã hủy 20 chuyến bay do ảnh hưởng của cơn bão.", "Reuters cho biết"],
  ["Zing", "Theo AFP, 20 chuyến bay bị hủy vì bão lớn", "Theo AFP, cơn bão lớn đã buộc các hãng hàng không hủy 20 chuyến bay.", "theo AFP"],
  ["VTimes", "According to Reuters, storm cancels 20 flights", "According to Reuters, the storm forced airlines to cancel 20 flights on Tuesday.", "according to Reuters"],
  ["DailyPost", "Reuters reported 20 flights were cancelled", "Reuters reported that airlines cancelled 20 flights as the storm hit.", "Reuters reported"],
  ["NewsHub", "Dẫn nguồn AFP: 20 chuyến bay bị hủy", "Dẫn nguồn tin AFP, 20 chuyến bay đã bị hủy do siêu bão.", "dẫn nguồn AFP"],
  ["E-Bao", "Theo hãng tin Reuters, bão hủy 20 chuyến bay", "Theo hãng tin Reuters, cơn bão đã khiến 20 chuyến bay bị hủy.", "theo hãng tin Reuters"],
  ["InfoNet", "Citing AFP, storm grounds 20 flights", "Citing AFP reports, the storm grounded 20 flights across the region.", "citing AFP"],
];
for (const [src, t, s, note] of attrCases) {
  add(
    "quoted",
    doc(src, t, s, 30, { language: /theo|dẫn|hãng tin|cho biết/i.test(t + s) ? "vi" : "en" }),
    attrPool,
    note,
  );
}

/* --------- C. independent same-fact reporting (×10) --------- */
// same event, different newsrooms, different text — MUST stay original
const indep: [string, string, string, string][] = [
  ["BBC World News", "Airports shut as storm tears through coast", "Airports confirmed 20 flight cancellations as the storm made landfall; passengers were advised to check schedules.", "en"],
  ["CNN", "Hurricane-force storm strands thousands at airports", "At least 20 flights were cancelled and rail services suspended after the storm hit the coast overnight.", "en"],
  ["VnExpress", "20 chuyến bay bị hủy do bão lớn đổ bộ", "Các hãng hàng không thông báo hủy 20 chuyến bay trong và ngoài nước khi bão đổ bộ sáng nay.", "vi"],
  ["Tuổi Trẻ", "Bão lớn làm tê liệt hàng không: 20 chuyến bị hủy", "Sân bay quốc tế đóng cửa 6 giờ; lực lượng cứu hộ trực chiến suốt đêm.", "vi"],
  ["Thanh Niên", "Hàng nghìn khách mắc kẹt vì 20 chuyến bay bị hủy", "Nhiều hành khách phải ngủ lại sân bay khi 20 chuyến bay bị hủy do ảnh hưởng bão.", "vi"],
  ["NHK", "台風で航空20便欠航", "嵐の上陸により20便が欠航、数千人の乗客が空港に足止めされた。", "en"],
  ["Yonhap", "Storm cancels 20 flights at regional airports", "Twenty flights were cancelled as the powerful storm swept through the region, the transport ministry said.", "en"],
  ["SCMP", "Flights scrapped as typhoon lashes coast", "Airlines cancelled 20 flights and ferries were halted as the typhoon brought 120km/h winds.", "en"],
  ["Dân Trí", "Bão lớn: sân bay đóng cửa, 20 chuyến bay hủy", "Ban quản lý sân bay cho biết toàn bộ 20 chuyến bay trong ngày bị hủy do thời tiết xấu.", "vi"],
  ["VietnamPlus", "20 flights cancelled due to major storm", "Twenty flights were cancelled Wednesday as the storm system moved inland, per airport authorities.", "en"],
];
for (const [src, t, s, lang] of indep) {
  add("original", doc(src, t, s, 40, { language: lang }), attrPool, "independent newsroom");
}

/* ------------- D. primary → publisher (×5) ------------- */
const fed = doc(
  "Federal Reserve",
  "Federal Reserve holds interest rate at 4.5%",
  "The Committee decided to maintain the target for the federal funds rate at 4.5 percent.",
  -120,
  { language: "en", sourceKind: "primary" },
);
const cb = doc(
  "Công báo Chính phủ",
  "Nghị định 102/2026/NĐ-CP",
  "Quy định về quản lý hoạt động thương mại điện tử.",
  -200,
  { sourceKind: "primary" },
);
add("press_release_based", doc("Reuters", "Fed giữ lãi suất 4.5% theo thông cáo", "Theo thông cáo của Fed, lãi suất được giữ nguyên ở mức 4.5%.", 10), [fed], "theo thông cáo");
add("press_release_based", doc("Bloomberg", "Fed holds rate steady in statement", "In a statement, the Federal Reserve held the interest rate at 4.5%.", 12, { language: "en" }), [fed], "in a statement");
add("press_release_based", doc("VnEconomy", "Nghị định 102/2026/NĐ-CP vừa ban hành", "Theo công văn của Chính phủ, Nghị định 102 quy định quản lý TMĐT có hiệu lực từ 1/11.", 15), [cb], "theo công văn");
add("press_release_based", doc("CafeF", "Nghị định 102/2026 quy định mới về TMĐT", "Theo văn bản ban hành trên Công báo, nghị định mới siết quản lý sàn TMĐT xuyên biên giới.", 18), [cb], "theo văn bản Công báo");
add("press_release_based", doc("MarketWatch", "Fed keeps rate at 4.5% per official statement", "According to the official statement, the FOMC kept the federal funds rate at 4.5%.", 20, { language: "en" }), [fed], "official statement");

/* --------- E. publisher → local rewrite (×5) --------- */
const apBig = doc(
  "AP",
  "Sâm banh Pháp chính thức cấm bán tại sân bay",
  "Nhà chức trách Pháp thông báo cấm bán sâm banh tại tất cả sân bay từ tháng sau.",
  -90,
);
const rewrites: [string, string, string][] = [
  ["Báo Mới", "Sâm banh Pháp chính thức bị cấm tại các sân bay", "Nhà chức trách Pháp vừa thông báo lệnh cấm bán sâm banh ở tất cả sân bay kể từ tháng tới."],
  ["Tin Tức", "Pháp cấm bán sâm banh tại sân bay từ tháng sau", "Theo quyết định mới, sâm banh sẽ không được bán tại các sân bay của Pháp."],
  ["Đọc Báo", "Sâm banh Pháp chính thức cấm bán ở sân bay", "Các sân bay tại Pháp sẽ ngừng bán sâm banh theo thông báo mới nhất của nhà chức trách."],
  ["NewsVN", "Lệnh cấm sâm banh tại sân bay Pháp có hiệu lực", "Nhà chức trách Pháp chính thức cấm bán sâm banh tại mọi sân bay."],
  ["24H", "Sâm banh Pháp chính thức cấm bán tại sân bay quốc tế", "Theo thông báo chính thức, sâm banh sẽ bị cấm bán ở các sân bay Pháp từ tháng sau."],
];
for (const [src, t, s] of rewrites) {
  add("rewritten", doc(src, t, s, 60), [apBig], "reworded, same facts");
}

/* ------------- F. cross-language copy (×4) ------------- */
// vi translation of an en wire — lexical signal is thin; labeled derived
// even though V1 likely misses (honest recall cost, not a precision risk)
add("syndicated", doc("Báo Dịch", "Bão lớn khiến 20 chuyến bay bị hủy", "Một cơn bão lớn đổ bộ hôm thứ Ba, buộc các hãng hàng không hủy 20 chuyến bay và khiến hàng nghìn hành khách bị mắc kẹt.", 50), [reuters], "vi translation of en wire");
add("rewritten", doc("TranslateNews", "Storm causes 20 flight cancellations", "Cơn bão lớn đã buộc các hãng hàng không phải hủy 20 chuyến bay hôm thứ Ba.", 55, { language: "en" }), [doc("TTXVN", wireTitle, wireSum, -30)], "en rewrite of vi wire");
add("quoted", doc("Soha", "Theo AP: hơn 20 chuyến bay hủy vì bão", "Theo tin từ AP, trên 20 chuyến bay đã bị hủy do cơn bão lớn đổ bộ vào sáng nay.", 45), [afp, doc("AP", wireEn.t, wireEn.s, -40, { language: "en" })], "vi cites AP");
add("original", doc("Blog Mỹ", "Why this storm is different from last year's", "Analysis: unlike the 2025 typhoon, this system stalled over the coast for six hours.", 70, { language: "en" }), attrPool, "analysis, not a copy");

/* --------- G. same publisher multiple articles (×3) --------- */
const vn1 = doc("VnExpress", "Giá vàng tăng mạnh trong phiên sáng", "Giá vàng SJC tăng 500.000 đồng/lượng trong phiên giao dịch sáng.", -30);
add("rewritten", doc("VnExpress", "Giá vàng tăng mạnh trong phiên sáng", "Giá vàng SJC tăng 500.000 đồng/lượng trong phiên giao dịch sáng.", 0), [vn1], "same outlet, same-day update — derived from own piece");
const tt1 = doc("Tuổi Trẻ", "U23 Việt Nam thắng 2-0 trận ra quân", "Đội tuyển U23 Việt Nam đánh bại đối thủ 2-0 trong trận mở màn.", -40);
add("rewritten", doc("Tuổi Trẻ", "U23 Việt Nam thắng 2-0 trận ra quân giải ĐNÁ", "U23 Việt Nam khởi đầu giải đấu bằng chiến thắng 2-0 trước đối thủ mạnh.", 0), [tt1], "same outlet second piece — derived from own earlier text");
add("syndicated", doc("Báo Khác", "U23 Việt Nam thắng 2-0 trận ra quân", "Đội tuyển U23 Việt Nam đánh bại đối thủ 2-0 trong trận mở màn.", 10), [tt1], "different outlet copies Tuổi Trẻ");

/* --------- H. similar wording, different event (×6) --------- */
// same predicate vocabulary but DIFFERENT facts — must not collapse
add("original", doc("Báo A", "Bão nhỏ: 5 chuyến bay bị hủy tại sân bay Đà Nẵng", "Bão nhỏ khiến 5 chuyến bay bị hủy tại sân bay Đà Nẵng chiều qua.", 80), [doc("TTXVN", wireTitle, wireSum, -30)], "different storm, different count");
add("original", doc("Báo B", "35 chuyến bay bị hủy do sương mù dày đặc", "Sương mù khiến 35 chuyến bay bị hủy tại Nội Bài sáng nay — không liên quan bão.", 85), [doc("TTXVN", wireTitle, wireSum, -30)], "same phrasing, different cause");
add("rewritten", doc("Báo C", "20 chuyến tàu bị hủy do bão lớn", "Bão lớn cũng khiến 20 chuyến tàu bị hủy trên tuyến Bắc-Nam.", 90), [doc("TTXVN", wireTitle, wireSum, -30)], "same storm + near-same wording — derived coverage, not independent");
add("original", doc("Báo D", "Sân bay mở lại sau khi 20 chuyến bay bị hủy", "Sân bay đã hoạt động trở lại; 20 chuyến bị hủy hôm qua sẽ được bù lịch.", 300), [doc("TTXVN", wireTitle, wireSum, -30)], "follow-up story");
add("original", doc("TechDaily", "Apple cắt giảm 2.000 nhân sự mảng AI", "Apple xác nhận cắt giảm 2.000 vị trí trong bộ phận AI, khác với tin đồn trước đó.", 100, { language: "vi" }), [doc("ReutersTech", "Apple cuts 2,000 AI jobs", "Apple confirmed 2,000 job cuts in its AI division.", -50, { language: "en" })], "different framing same fact — cross-lang thin signal stays original");
add("original", doc("Opinion", "Bình luận: 20 chuyến bay bị hủy và bài học khủng hoảng", "Phân tích sâu vụ 20 chuyến bay bị hủy: hệ thống cảnh báo sân bay cần thay đổi.", 400), [doc("TTXVN", wireTitle, wireSum, -30)], "opinion piece, own reporting");

/* ------------- I. same event, independent evidence (×4) ------------- */
// explicitly different reporting styles on the same event
add("original", doc("FieldReporter", "Tận mắt chứng kiến: sân bay hỗn loạn vì 20 chuyến hủy", "Phóng viên tại sân bay ghi nhận hàng nghìn hành khách xếp hàng suốt đêm sau khi 20 chuyến bị hủy.", 95), [doc("TTXVN", wireTitle, wireSum, -30)], "eyewitness report");
add("original", doc("DataNews", "Toàn cảnh 20 chuyến bay bị hủy theo dữ liệu radar", "Dữ liệu flight radar cho thấy đúng 20 chuyến đã hủy trong 6 giờ qua.", 100), [doc("TTXVN", wireTitle, wireSum, -30)], "data-driven verification");
add("original", doc("Interview", "Hành khách kể lại đêm trắng khi 20 chuyến bay bị hủy", "Loạt phỏng vấn hành khách mắc kẹt sau quyết định hủy 20 chuyến bay.", 110), [doc("TTXVN", wireTitle, wireSum, -30)], "interview-based");
add("rewritten", doc("Hãng Tin Copy", wireTitle, "Bão lớn đổ bộ khiến 20 chuyến bay bị hủy, hàng nghìn hành khách mắc kẹt tại các sân bay trong khu vực hôm nay.", 65), [doc("TTXVN", wireTitle, wireSum, -30)], "one-word tail edit — still wire");

console.log(cases.map((c) => JSON.stringify(c)).join("\n"));
