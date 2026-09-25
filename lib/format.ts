/**
 * Shared claim/value formatting — pure functions, no runtime deps, so both
 * the DB writer (change summaries) and client components (EventIntel) render
 * identical text. Kept out of writer.ts because that module pulls `pg`.
 */

/** Canonical predicate → vi display label. Free-text predicates (LLM fact
 *  claims) fall back to the claim's own label span. */
export const PRED_LABEL_VI: Record<string, string> = {
  deaths: "Số người thiệt mạng",
  injured: "Số người bị thương",
  missing: "Số người mất tích",
  evacuated: "Số người sơ tán",
  victims: "Số nạn nhân",
  arrests: "Số người bị bắt",
  flights_cancelled: "Chuyến bay bị hủy",
  interest_rate: "Lãi suất",
  growth_pct: "Tăng trưởng",
  sentence_years: "Án tù",
  damage_vnd: "Thiệt hại",
  damage_usd: "Thiệt hại",
  magnitude: "Độ lớn",
  money_usd: "Giá trị",
  money_vnd: "Giá trị",
  area_ha: "Diện tích",
};

const UNIT_SUFFIX: Record<string, string> = {
  people: " người",
  flights: " chuyến bay",
  "%": "%",
  years: " năm tù",
  richter: " độ Richter",
  ha: " ha",
};

/** vi number format — "1,3" and "24.507", not JSON stringify. */
const fmtNum = (n: number): string =>
  n.toLocaleString("vi-VN", { maximumFractionDigits: 2 });

/** Money stored normalized in tỷ (billion) — render human scale:
 *  0.0013 ty_usd → "1,3 triệu USD", 4 → "4 tỷ USD", 1500 → "1,5 nghìn tỷ USD". */
const fmtMoney = (n: number, unit: string): string => {
  const cur = unit === "ty_usd" || unit === "usd_bn" ? "USD" : "đồng";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${fmtNum(n / 1000)} nghìn tỷ ${cur}`;
  if (abs >= 1) return `${fmtNum(n)} tỷ ${cur}`;
  return `${fmtNum(n * 1000)} triệu ${cur}`;
};

/** Human-readable claim value with unit — "35 người", "1,3%", "4 tỷ USD",
 *  "5–25 triệu USD" (range carries the unit once, on the tail). */
export const fmtClaimValue = (v: unknown, unit?: string | null): string => {
  const money = unit && ["ty_vnd", "ty_usd", "usd_bn"].includes(unit);
  const fmtOne = (n: number): string =>
    money
      ? fmtMoney(n, unit)
      : `${fmtNum(n)}${UNIT_SUFFIX[unit ?? ""] ?? (unit ? ` ${unit}` : "")}`;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    if (typeof r.low === "number" && typeof r.high === "number") {
      if (money) {
        const cur = unit === "ty_vnd" ? "đồng" : "USD";
        const k = Math.abs(r.high) >= 1 ? 1 : 1000;
        const scale = k === 1 ? "tỷ" : "triệu";
        return `${fmtNum(r.low * k)}–${fmtNum(r.high * k)} ${scale} ${cur}`;
      }
      const suffix = UNIT_SUFFIX[unit ?? ""] ?? (unit ? ` ${unit}` : "");
      return `${fmtNum(r.low)}–${fmtNum(r.high)}${suffix}`;
    }
  }
  if (typeof v === "number") return fmtOne(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

interface ClaimLike {
  predicate: string;
  label: string;
  value: unknown;
  unit?: string | null;
  valueType?: string;
  qualifiers?: unknown;
}

/** One display line for a claim: "Federal Reserve — Lãi suất: 4,5%" or
 *  "Số người thiệt mạng: 35 người". Text claims render their label as-is. */
export function claimDisplayText(claim: ClaimLike): string {
  const subject =
    claim.qualifiers && typeof claim.qualifiers === "object"
      ? ((claim.qualifiers as Record<string, unknown>).subject as
          string | undefined)
      : undefined;
  const pred = PRED_LABEL_VI[claim.predicate] ?? claim.label;
  const head = subject ? `${subject} — ${pred}` : pred;
  if (claim.valueType === "number" || claim.valueType === "range")
    return `${head}: ${fmtClaimValue(claim.value, claim.unit)}`;
  return head;
}
