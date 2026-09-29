/* R7.1d.1c — regenerate tests/fixtures/materiality-events-labels.json.
 *
 * Reviewed decisions live HERE as the source of truth. Rows carry explicit
 * gold channels/targets (typed "type:key") + reviewed driver verdicts for
 * the ~35-event independently-reviewed subset (all gold/pred meaningful+,
 * all high-FP, giant clusters, representative limited). Unreviewed rows
 * keep derived fields for debugging but are excluded from metrics via the
 * *Reviewed flags — gold can never be silently cloned from predictions.
 *
 *   npx tsx scripts/materiality/gen-events-labels.mts
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Dec {
  m: string; // gold materiality
  s?: string | null; // gold scope — reviewed even when null
  drv?: "derive" | "none"; // derive drivers from claims at gold level
  ch?: string[]; // explicit override
  t?: string[]; // explicit override (type:key)
  fp?: string; // high-FP cause annotation
  note?: string;
  /* rv:true = channels/targets/drivers were REVIEWED independently of
   * scorer output. Derived-only rows stay for debugging but never count
   * toward transmission/driver accuracy. */
  rv?: boolean;
}

const L: Record<string, Dec> = {
  /* ── predicted meaningful+major — all reviewed ── */
  "01a0d176|Ông Trump đón ông Tập": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    rv: true,
    note: "US-China tariff truce; tariff_change+trade_agreement legit",
  },
  "01a0d3a9|Bầu trời Kiev": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["funding_liquidity"],
    t: ["country_exposure:ua"],
    rv: true,
    note: "strike + €6.6B military-aid disbursement context",
  },
  "01a0d4ed|White House restores": {
    m: "none",
    s: null,
    ch: [],
    t: [],
    drv: "none",
    rv: true,
    fp: "upstream_miscluster",
    note: "media-access story; $30B tariff claims mis-clustered US-China content",
  },
  "01a0e2aa|Iran không còn": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: ["country_exposure:ir"],
    rv: true,
    fp: "upstream_miscluster",
    note: "Iran sanctions-track tension; aid claims partially tangential",
  },
  "01a0d3aa|Biểu cảm trái ngược": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    rv: true,
    note: "Trump-Xi summit; trade_agreement+sanction_change legit",
  },
  "01a0d3aa|Ông Tập tới Mỹ": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    rv: true,
    note: "Xi US visit; trade_agreement claims legit",
  },
  "01a0d905|Colombia": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: ["country_exposure:ir"],
    rv: true,
    fp: "claim_scorer",
    note: "diplomatic break scored sanction_change meaningful — claim-layer over-elevation",
  },
  "01a0dd9e|Tiêu điểm 26/9": {
    m: "limited",
    s: "global_systemic",
    drv: "none",
    ch: ["fundamental"],
    t: [],
    rv: true,
    fp: "upstream_miscluster",
    note: "roundup video; €6.6B aid claims tangential",
  },
  "01a0e25c|Thụy Sĩ": {
    m: "none",
    s: null,
    ch: [],
    t: [],
    drv: "none",
    rv: true,
    fp: "upstream_miscluster",
    note: "Swiss neutrality referendum; aid claim mis-clustered",
  },
  "01a0d176|Chủ tịch Tập Cận Bình": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory", "external"],
    t: ["country_exposure:us", "country_exposure:cn"],
    rv: true,
    note: "Xi arrival; trade_agreement claims legit",
  },
  "01a0e257|FPT": {
    m: "limited",
    s: "issuer",
    drv: "none",
    ch: ["fundamental"],
    t: [],
    rv: true,
    fp: "upstream_miscluster",
    note: "FPT talent proposal = issuer news; tariff claims mis-clustered",
  },
  "01a0e335|Nâng tầm hợp tác an ninh": {
    m: "none",
    s: null,
    ch: [],
    t: [],
    drv: "none",
    rv: true,
    fp: "upstream_miscluster",
    note: "VN security cooperation; aid claim mis-clustered",
  },
  "01a0def9|Palestine": {
    m: "none",
    s: null,
    ch: [],
    t: [],
    drv: "none",
    rv: true,
    fp: "upstream_miscluster",
    note: "election candidates; military-aid claim mis-clustered",
  },
  "01a0e572|Tỷ lệ nghèo": {
    m: "meaningful",
    s: "global_systemic",
    drv: "derive",
    ch: ["fundamental"],
    t: ["country_exposure:us"],
    rv: true,
    note: "US poverty record low = real macro print",
  },
  "01a0e755|gấu trúc": {
    m: "none",
    s: null,
    ch: [],
    t: [],
    drv: "none",
    rv: true,
    fp: "upstream_miscluster",
    note: "panda diplomacy; $60B tariff claim mis-clustered",
  },
  /* ── limited band — reviewed ── */
  "01a0d176|Iran nói Mỹ còn 5 ngày": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["fundamental"],
    t: ["country_exposure:ir"],
    rv: true,
    note: "Hormuz ultimatum; oil supply channel",
  },
  "01a0d176|Board of Peace": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["funding_liquidity"],
    t: [],
    rv: true,
    note: "$2.45bn Gaza reconstruction",
  },
  "01a0d705|Thương mại Việt Nam - Canada": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["external"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "VN-Canada trade stats",
  },
  "01a0d3aa|Tô Lâm bắt đầu": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["external"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "VN leader Canada state visit",
  },
  "01a0d851|Mỹ, Iran xem xét": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "Hormuz reopening roadmap",
  },
  "01a0d188|trung chuyển": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "VN rejects transshipment in tariff talks",
  },
  "01a0dc10|A330": {
    m: "limited",
    s: "sector",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "aircraft delivery; aviation",
  },
  "01a0d87d|vi mạch": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["fundamental"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "VN chip workforce",
  },
  "01a0de40|Mỹ-Iraq": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: [],
    rv: true,
    note: "US-Iraq military→economic shift",
  },
  "01a0dede|OpenAI": {
    m: "limited",
    s: "sector",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "AI/cyber sector",
  },
  "01a0e8f9|SHB": {
    m: "limited",
    s: "issuer",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "SHB import-export finance; issuer",
  },
  "01a0e182|5,7 tỷ USD": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["funding_liquidity"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "$5.7B cumulative HCMC industrial zones",
  },
  "01a0e769|Ban Chỉ đạo 57": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "PM socio-economic committee",
  },
  "01a0d188|dioxin": {
    m: "limited",
    s: "vietnam",
    drv: "derive",
    ch: ["funding_liquidity"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "US dioxin project $430M",
  },
  "01a0e1ab|gạo": {
    m: "meaningful",
    s: "vietnam",
    drv: "derive",
    ch: ["policy_regulatory"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "rice import/export decree — sector policy",
  },
  "01a0d45b|diesel": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "EU diesel record; fuel channel indirect",
  },
  "01a0d188|ADB": {
    m: "meaningful",
    s: "vietnam",
    drv: "derive",
    ch: ["fundamental"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "ADB raises VN GDP forecast 7.8%",
  },
  "01a0d788|Giá vàng": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["discounting"],
    t: [],
    rv: true,
    note: "gold one-week low on rate expectations",
  },
  "01a0d828|Giá dầu tăng vọt": {
    m: "limited",
    s: "global_systemic",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "oil spike after Houthi claims",
  },
  "01a0d3a9|Vietjet": {
    m: "limited",
    s: "issuer",
    drv: "derive",
    ch: ["fundamental"],
    t: [],
    rv: true,
    note: "VietJet-Starlink; issuer",
  },
  "01a0d789|Malaysia": {
    m: "meaningful",
    s: "vietnam",
    drv: "derive",
    ch: ["external", "policy_regulatory"],
    t: ["country_exposure:vn"],
    rv: true,
    note: "VN-Malaysia $20B trade target",
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
    note: "charity; indicator claims are extraction noise",
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
  const gi = order.indexOf(lb.m);
  const atGold =
    gi <= 0 ? [] : live.filter((c) => order.indexOf(c.materiality) >= gi);
  const drv = lb.drv === "derive" ? atGold.map((c) => c.claimId).sort() : [];
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
    /* independence gates: only rv:true rows count in channel/target/driver
     * metrics — derived values stay for debugging but MUST NOT inflate
     * independent-validation numbers */
    driversReviewed: !!lb.rv,
    channelsReviewed: !!lb.rv,
    targetsReviewed: !!lb.rv,
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
      methodVersion: "r7.1d.1c",
      selectionVersion: "events-v1",
      corpusHash: corpus.corpusHash,
      labelCount: labels.length,
      labels,
    },
    null,
    2,
  ),
);
