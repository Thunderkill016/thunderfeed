/* R7.1d.1d — regenerate tests/fixtures/materiality-events-labels.json.
 *
 * Reviewed decisions live HERE as the source of truth. Per-field review
 * gates are DERIVED FROM FIELD PRESENCE, never from a blanket flag:
 *
 *   driversReviewed  = d  !== undefined   (explicit claim ids by semantics)
 *   channelsReviewed = ch !== undefined
 *   targetsReviewed  = t  !== undefined
 *
 * `d` is the reviewer's own choice of which claims legitimately carry the
 * event's materiality — decided from event + claim semantics, NOT filtered
 * by claim.materiality level (that would re-import scorer output). For
 * gold-none events d:[] asserts no claim is a legitimate driver. Rows with
 * rv:true must supply all three of d/ch/t.
 *
 * Rows without d/ch/t keep derived fields for debugging but are excluded
 * from the corresponding metric denominator.
 *
 *   npx tsx scripts/materiality/gen-events-labels.mts
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Dec {
  m: string; // gold materiality
  s?: string | null; // gold scope — reviewed even when null
  d?: string[]; // REVIEWED driver claim ids (full uuids)
  drv?: "derive" | "none"; // debug-only derived drivers when d absent
  ch?: string[]; // reviewed channels
  t?: string[]; // reviewed targets (typed "type:key")
  fp?: string; // high-FP cause annotation
  note?: string;
  /* rv:true = all three transmission fields were independently reviewed;
   * generator throws if rv is set but d/ch/t is missing. */
  rv?: boolean;
}

const L: Record<string, Dec> = {
  /* ── predicted meaningful+/major — all fully reviewed ── */
  "01a0d176|Ông Trump đón ông Tập": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0dd77-21ac-7ae3-b6b6-8cc88603d07f", // tariff_reduction 30 tỷ
      "01a0dd9d-56eb-7a99-a5a3-da3710bc8d29", // tariff_reduction_value 30 tỷ
      "01a0ddbb-6e85-7573-aa68-fa0dede4fbb6", // tariff_reduction_value 30 tỷ
      "01a0dff7-ec59-7a37-8c40-7e68e3ab136a", // trade_agreement 30 tỷ
      "01a0e00a-5760-7bc6-878c-c0bd94bdf4fc", // tariff_reduction 30 tỷ
      "01a0e056-8f1c-7cf3-ab67-74d04d5b5249", // trade_agreement 30 tỷ
      "01a0d7eb-abe8-7f2c-a89f-d8993f1d145c", // trade_agreement_extension hai tháng — headline content
    ],
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    note: "US-China tariff truce; tariff/trade claims legit drivers",
  },
  "01a0d3a9|Bầu trời Kiev": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0dba5-8145-7b14-8c3a-a2d53e0507f4", // fund_disbursement 6,6 tỉ euro
      "01a0dc2f-7cf4-7ca0-9d12-2ca5b56b88a9",
      "01a0dcf3-498d-76fb-95a8-1771fa18e70b",
      "01a0dd31-e2b0-73cb-a410-91fbdd3cd8ef",
      "01a0dd54-ae30-761d-a04b-ea4a3a7ccc51", // aid_disbursement 6,6 tỷ
      "01a0dddd-8f3e-789d-afed-eb2bd525043d", // military_aid_disbursement
      "01a0e2e2-f330-75e8-af48-378b16f6ab98", // disbursement
    ],
    ch: ["funding_liquidity"],
    t: ["country_exposure:ua"],
    note: "strike + €6.6B military-aid disbursement context",
  },
  "01a0d4ed|White House restores": {
    m: "none",
    s: null,
    rv: true,
    d: [],
    ch: [],
    t: [],
    fp: "upstream_miscluster",
    note: "media-access story; $30B tariff claims mis-clustered US-China content",
  },
  "01a0e2aa|Iran không còn": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: ["01a0e2e3-3d53-78df-ba8d-97a3409b9d9e"], // sanctions — banking disruption is the distrust context
    ch: ["policy_regulatory"],
    t: ["country_exposure:ir"],
    fp: "upstream_miscluster",
    note: "€6.6B aid claims mis-clustered; sanctions claim is on-topic",
  },
  "01a0d3aa|Biểu cảm trái ngược": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: ["01a0db17-25d3-74bc-8b45-fd458ce809d5"], // trade_agreement "thỏa thuận thương mại mới"
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    note: "Trump-Xi summit; sanctions claim is mis-clustered Iran content",
  },
  "01a0d3aa|Ông Tập tới Mỹ": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0dbed-1f06-7654-8d5d-e2cdbe67ee93", // trade_agreement_extension
      "01a0dc2a-0356-7c6c-9714-451d410cc6d5", // trade_agreement
    ],
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    note: "Xi US visit; trade_agreement claims legit",
  },
  "01a0d905|Colombia": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: ["01a0e26c-c013-7cda-98a7-a6c702631410"], // sanctions — on-topic, over-scored meaningful
    ch: ["policy_regulatory"],
    t: ["country_exposure:ir"],
    fp: "claim_scorer",
    note: "diplomatic break + banking disruption; claim-layer over-elevation",
  },
  "01a0dd9e|Tiêu điểm 26/9": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0e021-f5a8-74be-9a71-53951603efaf", // military_budget_uav 12 tỷ USD
      "01a0e24b-9ad3-7d4d-a342-66de144dde9b", // uav_budget 12 tỷ
      "01a0dd9f-3cb5-7355-abb7-a7415b132ded", // missile_agreement Patriot
      "01a0e24b-90c7-7583-9ed5-f94a5b197b68", // missile_agreement_reached
    ],
    ch: ["fundamental"],
    t: [],
    fp: "upstream_miscluster",
    note: "roundup video; €6.6B aid claims tangential — real items are UAV budget + Patriot deal",
  },
  "01a0e25c|Thụy Sĩ": {
    m: "none",
    s: null,
    rv: true,
    d: [],
    ch: [],
    t: [],
    fp: "upstream_miscluster",
    note: "Swiss neutrality referendum; aid claim mis-clustered",
  },
  "01a0d176|Chủ tịch Tập Cận Bình": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0d788-21b0-7c31-b515-3ff6bcd67e0f", // trade_agreement_extension hai tháng
      "01a0d788-21b5-75d1-a83c-c22b81fbfe41", // thêm hai tháng
    ],
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    note: "Xi arrival; truce extension claims legit",
  },
  "01a0e257|FPT": {
    m: "limited",
    s: "issuer",
    rv: true,
    d: [],
    ch: ["fundamental"],
    t: [],
    fp: "upstream_miscluster",
    note: "FPT talent proposal; tariff claims mis-clustered — no claim encodes the partnership",
  },
  "01a0e335|Nâng tầm hợp tác an ninh": {
    m: "none",
    s: null,
    rv: true,
    d: [],
    ch: [],
    t: [],
    fp: "upstream_miscluster",
    note: "VN security cooperation; aid claim mis-clustered",
  },
  "01a0def9|Palestine": {
    m: "none",
    s: null,
    rv: true,
    d: [],
    ch: [],
    t: [],
    fp: "upstream_miscluster",
    note: "election candidates; military-aid claim mis-clustered",
  },
  "01a0e572|Tỷ lệ nghèo": {
    m: "meaningful",
    s: "global_systemic",
    rv: true,
    d: ["01a0e572-10eb-7c2a-9c5e-9d9123d2f546"], // growth_pct 4 — the poverty/income stat
    ch: ["fundamental"],
    t: ["country_exposure:us"],
    note: "US poverty record low = real macro print",
  },
  "01a0e755|gấu trúc": {
    m: "none",
    s: null,
    rv: true,
    d: [],
    ch: [],
    t: [],
    fp: "upstream_miscluster",
    note: "panda diplomacy; $60B tariff claim mis-clustered",
  },
  /* ── limited band — fully reviewed ── */
  "01a0d176|Iran nói Mỹ còn 5 ngày": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0e267-edf9-7129-88f7-42695d4c1427", // bac_de_xuat đình chiến + Hormuz
      "01a0e55b-e28e-7f12-bbfd-97b9cf965670", // bac_de_xuat Hormuz
      "01a0e4ce-8943-7612-a3ac-28acd35fea89", // bac_de_xuat_mo_lai
      "01a0e561-3133-73f8-887e-15ecebb0d87b", // ceasefire_proposal 7 ngày
      "01a0e268-0101-7d65-83fb-6a562f7b096e", // de_xuat Hormuz 7 ngày
      "01a0e203-bc02-7b91-a928-2cc31c960125", // hormuz_proposal_duration
      "01a0e203-c44f-7ae3-ba28-62dabb64881c", // hormuz_proposal_rejection
      "01a0e247-8e96-7090-ab10-732aa41ef2d8", // hormuz_proposal_rejection
      "01a0e247-856c-75b6-ba5c-b27a48ca0f3f", // hormuz_proposal_timeline
      "01a0e224-637b-7fda-83af-e945eb50e8eb", // hormuz_reopen_proposal
      "01a0e1e1-50b2-720e-b3ac-a379acc56984", // hormuz_reopening_proposal
      "01a0e1bf-fbf6-75cf-b817-f013f1e8e7f6", // proposal mở cửa + ngừng bắn
      "01a0e3c0-b88f-7032-be24-3b12c01d4637", // proposal_rejected
      "01a0e1e1-59dc-78a0-8916-91f23859ea5f", // proposal_rejection
      "01a0e34b-808e-7b97-8487-8b26bddf5a94", // reject_proposal
      "01a0e2f8-aeba-7509-bb58-f19a7aa0be71", // rejected_proposal
      "01a0e2f8-c4a9-72e8-aa55-9c30f74b12de", // rejected_proposal
    ],
    ch: ["fundamental"],
    t: ["country_exposure:ir"],
    note: "Hormuz ultimatum; on-topic claims all scored unknown — under-scored drivers; budget/aid limited claims are mis-clustered",
  },
  "01a0d176|Board of Peace": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: ["01a0d7c9-e7bf-7d61-999e-c047a7b0753f"], // recovery_plan_budget 2.45
    ch: ["funding_liquidity"],
    t: [],
    note: "$2.45bn Gaza reconstruction",
  },
  "01a0d705|Thương mại Việt Nam - Canada": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [
      "01a0e0f3-c983-7cc9-9215-e50d6d4a7034", // growth_pct 29.13
      "01a0e352-67dc-7e61-80b0-312d6a1f062b", // fdi_growth_rate 29,13%
      "01a0e352-63aa-777a-951c-1df7a79be056", // foreign_direct_investment 5,7 tỷ
      "01a0e352-5f78-72a0-87f0-130140dd62ba", // financial_agreement_value 325tr
    ],
    ch: ["external"],
    t: ["country_exposure:vn"],
    note: "VN-Canada trade stats",
  },
  "01a0d3aa|Tô Lâm bắt đầu": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [
      "01a0d822-3271-718f-9781-b881f87dc226", // diplomatic_relation_upgrade Đối tác Chiến lược
      "01a0d822-36a2-731a-8801-1af66d5534b3", // upgrade date
      "01a0d7fb-26d3-74d8-8872-a52fa15571f5", // bilateral_relations
    ],
    ch: ["external"],
    t: ["country_exposure:vn"],
    note: "VN-Canada strategic-partnership upgrade",
  },
  "01a0d851|Mỹ, Iran xem xét": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0e067-a0b7-73b0-8564-b165896e0fa7", // hormuz_reopen_proposal 7 ngày
      "01a0e085-139b-7ba2-86a1-8711f6ae54f8", // reopen duration
      "01a0e092-7d3a-7a06-a8c9-1d1c4d95a0e5", // hormuz_reopening_plan
      "01a0e059-f9de-7d77-b994-4d6b2cf52c93", // hormuz_reopening_proposal
      "01a0e00d-3b9f-7628-8dca-1d982bb3a061", // proposed_plan
      "01a0e01d-bd57-732b-9ecc-7366d4b0b6fa", // de_xuat_lo_trinh
      "01a0e01d-c5d6-79d5-bec0-6c08dad29842", // ke_hoach_mo_lai
      "01a0e033-b66c-7758-a586-1a2b70691eb6", // impose_sanctions — bargaining chip
      "01a0e067-a700-7bc8-be1a-1f43aa5bb133", // sanctions
    ],
    ch: ["fundamental"],
    t: [],
    note: "Hormuz reopening roadmap",
  },
  "01a0d188|trung chuyển": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [],
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    note: "VN rejects transshipment; headline content never extracted as a claim — upstream extraction gap",
  },
  "01a0dc10|A330": {
    m: "limited",
    s: "sector",
    rv: true,
    d: [],
    ch: ["fundamental"],
    t: [],
    note: "aircraft delivery; price claims are mis-clustered gold — delivery not in claims",
  },
  "01a0d87d|vi mạch": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [
      "01a0d8f7-2e6a-7b40-aa6c-f2b073cdf955", // labor_demand 157.000 bán dẫn
      "01a0d93a-905c-769a-af37-2fa4888dc4d2", // labor_forecast
    ],
    ch: ["fundamental"],
    t: ["country_exposure:vn"],
    note: "VN chip workforce",
  },
  "01a0de40|Mỹ-Iraq": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: [
      "01a0e058-d902-748e-bf02-93bb621dc88b", // blacklist 61 công ty
      "01a0e066-d38f-71e8-b7fc-836344040f54",
    ],
    ch: ["policy_regulatory"],
    t: [],
    note: "US-Iraq military→economic shift; entity-blacklist claims are the economic content",
  },
  "01a0dede|OpenAI": {
    m: "limited",
    s: "sector",
    rv: true,
    d: ["01a0e42e-3c2f-70b9-9d01-7c5c3d614002"], // cyber_incident
    ch: ["fundamental"],
    t: [],
    note: "AI/cyber sector",
  },
  "01a0e8f9|SHB": {
    m: "limited",
    s: "issuer",
    rv: true,
    d: ["01a0e94d-d18f-7bd7-8d52-4fd022d2ece9"], // growth_pct 55.4 — export-finance growth
    ch: ["fundamental"],
    t: [],
    note: "SHB import-export finance; issuer",
  },
  "01a0e182|5,7 tỷ USD": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [
      "01a0e1ee-9367-745a-b947-dfa14402839f", // investment_attraction 5,7 tỷ
      "01a0e182-12ea-7756-a3c6-0eed9f20661f", // growth_pct 29.13
      "01a0e1ee-97f3-7411-95aa-a154c6c4045f", // investment_growth_rate
      "01a0e182-143d-71d7-a71b-75f7285d8db4", // money_usd 5.7
    ],
    ch: ["funding_liquidity"],
    t: ["country_exposure:vn"],
    note: "$5.7B cumulative HCMC industrial zones",
  },
  "01a0e769|Ban Chỉ đạo 57": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: ["01a0e8c4-90b2-7f30-8b17-2db3d2225f00"], // growth_pct 14.5 growth target
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    note: "PM socio-economic committee",
  },
  "01a0d188|dioxin": {
    m: "limited",
    s: "vietnam",
    rv: true,
    d: [],
    ch: ["funding_liquidity"],
    t: ["country_exposure:vn"],
    note: "US dioxin $430M; figure never extracted — upstream extraction gap",
  },
  "01a0e1ab|gạo": {
    m: "meaningful",
    s: "vietnam",
    rv: true,
    d: [],
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    note: "rice import/export decree — sector policy not extracted as claim",
  },
  "01a0d45b|diesel": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: [],
    ch: ["fundamental"],
    t: [],
    note: "EU diesel record; growth_pct claim is noise — fuel content not extracted",
  },
  "01a0d188|ADB": {
    m: "meaningful",
    s: "vietnam",
    rv: true,
    d: ["01a0d188-8962-7656-9416-adc778311d13"], // growth_pct 7.8 GDP forecast
    ch: ["fundamental"],
    t: ["country_exposure:vn"],
    note: "ADB raises VN GDP forecast 7.8%; claim under-scored at limited",
  },
  "01a0d788|Giá vàng": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: ["01a0d788-fb43-7161-a66a-cb886f2528ce"], // interest_rate — stated driver of gold drop
    ch: ["discounting"],
    t: [],
    note: "gold one-week low on rate expectations",
  },
  "01a0d828|Giá dầu tăng vọt": {
    m: "limited",
    s: "global_systemic",
    rv: true,
    d: ["01a0d828-42b9-7088-9b37-573e8a66b3ad"], // oil_price one-week high
    ch: ["fundamental"],
    t: [],
    note: "oil spike after Houthi claims",
  },
  "01a0d3a9|Vietjet": {
    m: "limited",
    s: "issuer",
    rv: true,
    d: [],
    ch: ["fundamental"],
    t: [],
    note: "VietJet-Starlink; partnership not extracted as claim",
  },
  "01a0d789|Malaysia": {
    m: "meaningful",
    s: "vietnam",
    rv: true,
    d: [],
    ch: ["external", "policy_regulatory"],
    t: ["country_exposure:vn"],
    note: "VN-Malaysia $20B trade target; not extracted as claim",
  },
  /* ── remaining labels — materiality/scope reviewed, transmission derived ── */
  "01a0dc3c|Burnham": {
    m: "none",
    s: null,
    drv: "none",
    note: "UK Labour politics",
  },
  "01a0d7ec|Pezeshkian": {
    m: "none",
    s: null,
    drv: "none",
    note: "Iran rhetoric",
  },
  "01a0dc34|Trung thu yêu thương": {
    m: "none",
    s: null,
    drv: "none",
    note: "charity",
  },
  "01a0d9fa|máy nhắn tin": {
    m: "none",
    s: null,
    drv: "none",
    note: "Netanyahu pager theatrics",
  },
  "01a0dd8e|Phạm Gia Túc": {
    m: "none",
    s: null,
    drv: "none",
    note: "local cadre voter meeting",
  },
  "01a0d188|Triều Tiên bắn": { m: "none", s: null },
  "01a0d188|Sáng tạo trong số hóa": { m: "none", s: null },
  "01a0d3aa|thỏa thuận kinh tế với Nga": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    note: "possible US-Russia economic deal",
  },
  "01a0d3ad|Nga đẩy lùi": { m: "none", s: null },
  "01a0d6f3|Pháp hứa gửi quân": { m: "none", s: null },
  "01a0d6f4|xe tăng": { m: "none", s: null },
  "01a0d84e|Mecaa": { m: "none", s: null },
  "01a0d8dd|Thứ trưởng Bộ Công Thương": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "trade-ministry deputy appointment",
  },
  "01a0dbf2|Wallonie": { m: "none", s: null },
  "01a0dc36|Iran về nước": { m: "none", s: null },
  "01a0dc5d|đại biểu bỏ ra ngoài": { m: "none", s: null },
  "01a0dc64|Modi": { m: "none", s: null },
  "01a0dcde|Cảnh sát cơ động": { m: "none", s: null },
  "01a0dd07|Bangkok": {
    m: "limited",
    s: "sector",
    drv: "derive",
    note: "Bangkok flood disaster",
  },
  "01a0ddae|Lexus": { m: "none", s: null },
  "01a0e05f|du khách trong vùng lụt": {
    m: "limited",
    s: "sector",
    drv: "derive",
    note: "Thai tourist support amid floods",
  },
  "01a0e0e7|MICE": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "VN MICE tourism cooperation",
  },
  "01a0e1db|710 triệu euro": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    note: "EU €710M crisis aid",
  },
  "01a0e1f7|South Africa": { m: "none", s: null },
  "01a0e33f|Yemen": { m: "none", s: null },
  "01a0d91d|HLV Philippines": { m: "none", s: null },
  "01a0d176|Hùng Cao": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "Tô Lâm meets US envoy NY",
  },
  "01a0e72f|Hiền Thục": { m: "none", s: null },
  "01a0d91e|Canada": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "VN-Canada tech cooperation",
  },
  "01a0d1ab|tứ kết": { m: "none", s: null },
  "01a0d188|Hàn Quốc": { m: "none", s: null },
  "01a0e047|Trung Quốc": { m: "none", s: null },
  "01a0e0a6|Costa Rica": { m: "none", s: null },
  "01a0e675|Nam Sudan": { m: "none", s: null },
  "01a0d7cd|HC bạc": { m: "none", s: null },
  "01a0d412|hàng cấm": { m: "none", s: null },
  "01a0db21|Israel": { m: "none", s: null },
  "01a0d3aa|Phú Long": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "QL13 toll change",
  },
  "01a0dbfd|Agentic AI": {
    m: "limited",
    s: "sector",
    drv: "derive",
    note: "agentic AI in VN ops",
  },
  "01a0e1fa|Robot": {
    m: "limited",
    s: "sector",
    drv: "derive",
    note: "robots as production force CN",
  },
  "01a0e805|525": { m: "none", s: null, note: "data-artifact title" },
  "01a0d942|hai con số": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    note: "double-digit growth target",
  },
  "01a0d6f3|Hormuz": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    note: "Hormuz navigation calls",
  },
  "01a0e6e1|74.000": { m: "none", s: null },
};

const corpus = JSON.parse(
  readFileSync("tests/fixtures/materiality-events-corpus.json", "utf8"),
);
const order = ["none", "limited", "meaningful", "major", "systemic"];
const labels = [];
const used = new Set<string>();
for (const it of corpus.items) {
  const id8 = it.eventId.slice(0, 8);
  let lb: Dec | null = null;
  for (const [k, v] of Object.entries(L)) {
    const [kid, ...rest] = k.split("|");
    if (id8 === kid && it.title.includes(rest.join("|"))) {
      lb = v;
      used.add(k);
      break;
    }
  }
  if (!lb) continue;
  if (
    lb.rv &&
    (lb.d === undefined || lb.ch === undefined || lb.t === undefined)
  ) {
    throw new Error(`reviewed row missing explicit d/ch/t: ${id8} ${it.title}`);
  }
  interface C {
    claimId: string;
    materiality: string;
    excluded?: boolean;
    channels?: string[];
    affectedTargets?: { type: string; key: string }[];
  }
  const claims: C[] = (
    it.claims as { assessment: object; claimId: string }[]
  ).map((c) => ({ ...c.assessment, claimId: c.claimId }) as C);
  const live = claims.filter((c) => !c.excluded);
  const claimIds = new Set(live.map((c) => c.claimId));
  const gi = order.indexOf(lb.m);
  const atGold =
    gi <= 0 ? [] : live.filter((c) => order.indexOf(c.materiality) >= gi);
  /* reviewed drivers are the reviewer's explicit list; otherwise keep
   * derived drivers for debugging only (driversReviewed stays false).
   * Every reviewed id must exist in the event's live claims — a typo or
   * stale id fails the generator rather than silently degrading recall. */
  const reviewedDrv = lb.d !== undefined;
  if (reviewedDrv) {
    for (const id of lb.d!) {
      if (!claimIds.has(id))
        throw new Error(`driver id not in event claims: ${id} @${id8}`);
    }
  }
  const drv = reviewedDrv
    ? [...lb.d!].sort()
    : lb.drv === "derive"
      ? atGold.map((c) => c.claimId).sort()
      : [];
  const ch =
    lb.ch ?? [...new Set(atGold.flatMap((c) => c.channels ?? []))].sort();
  const tg =
    lb.t ??
    [
      ...new Set(
        atGold.flatMap((c) =>
          (c.affectedTargets ?? []).map((x) => `${x.type}:${x.key}`),
        ),
      ),
    ].sort();
  labels.push({
    eventId: it.eventId,
    title: it.title.slice(0, 90),
    materiality: lb.m,
    /* scope is a REVIEWED field — null means the reviewer concluded the
     * event has no economic scope (typically materiality=none), not
     * "unlabeled". */
    scope: lb.s ?? null,
    scopeReviewed: lb.s !== undefined || lb.m === "none",
    channels: ch,
    affectedTargets: tg,
    driverClaimIds: drv,
    fpCause: lb.fp ?? null,
    /* independence gates derive from FIELD PRESENCE — a field counts only
     * when the reviewer supplied it explicitly */
    driversReviewed: lb.d !== undefined,
    channelsReviewed: lb.ch !== undefined,
    targetsReviewed: lb.t !== undefined,
    reviewed: true,
    note: lb.note ?? "",
  });
}
const missing = Object.keys(L).filter((k) => !used.has(k));
console.log(`labels=${labels.length} unusedKeys=${missing.length}`);
if (missing.length) console.log("UNUSED:", missing.join("\n  "));
writeFileSync(
  "tests/fixtures/materiality-events-labels.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      methodVersion: "r7.1d.1d",
      selectionVersion: "events-v1",
      corpusHash: corpus.corpusHash,
      labelCount: labels.length,
      labels,
    },
    null,
    2,
  ),
);
