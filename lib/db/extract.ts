/**
 * Deterministic claim extractor — P0 rules layer.
 *
 * Regex patterns over title + summary, Vietnamese and English, emitting
 * canonical predicates. The canonical key is the point: "20 chuyến bay bị
 * hủy" (VnExpress) and "20 flights cancelled" (BBC) produce the same
 * claim_key inside one event, so they version ONE claim — corroboration
 * and value disputes emerge from the shared key instead of entity work.
 *
 * Everything extracted is state "reported". The extractor never upgrades
 * authority — confirmation requires a primary-source claim later.
 * Precision over recall: numeric facts are the highest-value diff targets
 * ("20 → 35 chuyến bay") and regex keeps every claim auditable.
 */

import type { StoryCluster } from "../model";
import type { ExtractedClaim } from "./writer";

type Lang = "vi" | "en";

interface PatternDef {
  /** canonical predicate — also the claim_key (unique per event) */
  key: string;
  unit: string;
  /** optional named group `m` scales the captured number (e.g. "nghìn"×1000) */
  scale?: Record<string, number>;
  vi?: RegExp;
  en?: RegExp;
}

/*
 * Each regex exposes the number in named group `n` (and `n2` for the
 * reversed word-order alternation). Patterns are deliberately tight —
 * a false positive writes a wrong claim_version into history.
 */
const PATTERNS: PatternDef[] = [
  {
    key: "flights_cancelled",
    unit: "flights",
    vi: /(?<n>\d[\d.,]*)\s*chuyến bay[^.;]{0,40}?(?:bị\s+)?hủy|hủy[^.;]{0,20}?(?<n2>\d[\d.,]*)\s*chuyến bay/i,
    en: /(?<n>\d[\d.,]*)\s*flights?[^.;]{0,40}?cancell?ed|cancell?ed[^.;]{0,20}?(?<n2>\d[\d.,]*)\s*flights?/i,
  },
  {
    key: "deaths",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*người[^.;]{0,20}?(?:chết|thiệt mạng|tử vong)|(?:khiến|làm)[^.;]{0,20}?(?<n2>\d[\d.,]*)\s*người[^.;]{0,10}?(?:chết|thiệt mạng|tử vong)/i,
    en: /(?<n>\d[\d.,]*)\s*(?:people\s+)?(?:killed|dead|deaths?|died|fatalities)|(?:kills?|death toll(?:\s+of)?)[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
  },
  {
    key: "injured",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*người[^.;]{0,15}?bị thương/i,
    en: /(?<n>\d[\d.,]*)\s*(?:people\s+)?injured|injures?[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
  },
  {
    key: "missing",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*người[^.;]{0,15}?mất tích/i,
    en: /(?<n>\d[\d.,]*)\s*(?:people\s+)?(?:missing|unaccounted for)/i,
  },
  {
    key: "evacuated",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*(?:người|hộ dân)[^.;]{0,15}?(?:sơ tán|di tản)|sơ tán[^.;]{0,15}?(?<n2>\d[\d.,]*)\s*(?:người|hộ dân)/i,
    en: /(?<n>\d[\d.,]*)\s*(?:people\s+)?evacuated|evacuate[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
  },
  {
    key: "interest_rate",
    unit: "%",
    vi: /lãi suất[^0-9]{0,25}?(?:(?<lo>\d[.,]?\d*)\s*[–—]\s*(?<hi>\d[\d.,]*)|(?<n>\d[\d.,]*))\s*%/i,
    en: /(?:interest\s+rate|rate)[^0-9]{0,25}?(?:(?<lo>\d[.,]?\d*)\s*[–—-]\s*(?<hi>\d[\d.,]*)|(?<n>\d[\d.,]*))\s*%/i,
  },
  {
    key: "growth_pct",
    unit: "%",
    vi: /(?:tăng trưởng|tăng)[^0-9]{0,25}?(?<n>\d[\d.,]*)\s*%/i,
    en: /(?:grew|growth(?:\s+of)?|up)[^0-9]{0,20}?(?<n>\d[\d.,]*)\s*%/i,
  },
  {
    key: "sentence_years",
    unit: "years",
    vi: /(?<n>\d[\d.,]*)\s*năm tù|(?:tuyên phạt|phạt)[^.;]{0,15}?(?<n2>\d[\d.,]*)\s*năm(?:\s*tù)?/i,
    en: /sentenced?[^.;]{0,15}?(?<n>\d[\d.,]*)\s*years?|(?<n2>\d[\d.,]*)-year (?:prison|jail) sentence/i,
  },
  {
    key: "victims",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*(?:nạn nhân|người bị hại)|(?:lừa(?:\s*đảo)?|hại)[^.;]{0,20}?(?<n2>\d[\d.,]*)\s*(?:người|khách hàng|nạn nhân)/i,
    en: /(?<n>\d[\d.,]*)\s*victims?|victimiz(?:e|ed)[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
  },
  {
    key: "arrests",
    unit: "people",
    vi: /(?<n>\d[\d.,]*)\s*(?:người|bị can|đối tượng)[^.;]{0,15}?bị bắt|bắt giữ[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
    en: /(?<n>\d[\d.,]*)\s*(?:people\s+)?(?:arrested|detained)|arrests?[^.;]{0,15}?(?<n2>\d[\d.,]*)/i,
  },
  {
    key: "damage_vnd",
    unit: "ty_vnd",
    scale: { nghìn: 1000 },
    vi: /thiệt hại[^0-9]{0,25}?(?<n>\d[\d.,]*)\s*(?<m>nghìn\s+)?tỷ đồng|(?<n2>\d[\d.,]*)\s*(?<m2>nghìn\s+)?tỷ đồng[^.;]{0,15}?thiệt hại/i,
  },
  {
    key: "damage_usd",
    unit: "usd_bn",
    scale: { billion: 1, bn: 1, million: 0.001, mn: 0.001 },
    en: /(?:damage|losses|cost)[^0-9$]{0,25}?\$\s*(?<n>\d[\d.,]*)\s*(?<m>billion|bn|million|mn)/i,
  },
  {
    key: "magnitude",
    unit: "richter",
    vi: /(?:động đất|trận động đất)[^0-9]{0,25}?(?<n>\d[.,]\d+)\s*(?:độ\s*)?(?:richter)?/i,
    en: /magnitude[\s-]?(?<n>\d[.,]\d+)/i,
  },
  /* generic money — checked LAST so damage/loss contexts win the span;
     normalized to tỷ (billion-vnd / billion-usd) for cross-source diffs */
  {
    key: "money_usd",
    unit: "ty_usd",
    scale: {
      triệu: 0.001,
      tỷ: 1,
      "nghìn tỷ": 1000,
      million: 0.001,
      mn: 0.001,
      billion: 1,
      bn: 1,
      trillion: 1000,
      tn: 1000,
    },
    vi: /(?:(?<lo>\d[\d.,]*)\s*[-–]\s*(?<hi>\d[\d.,]*)|(?<n>\d[\d.,]*))\s*(?<m>triệu|tỷ|nghìn tỷ)\s*(?:USD|đô la(?:\s*Mỹ)?)/i,
    en: /\$\s*(?:(?<lo>\d[\d.,]*)\s*[-–]\s*\$?(?<hi>\d[\d.,]*)|(?<n>\d[\d.,]*))\s*(?<m>billion|bn|million|mn|trillion|tn)\b|(?<n2>\d[\d.,]*)\s*(?<m2>billion|million|trillion)\s*(?:USD|dollars)/i,
  },
  {
    key: "money_vnd",
    unit: "ty_vnd",
    scale: { nghìn: 1000 },
    vi: /(?<n>\d[\d.,]*)\s*(?<m>nghìn\s+)?tỷ đồng/i,
  },
  {
    key: "area_ha",
    unit: "ha",
    vi: /(?<n>\d[\d.,]*)\s*(?:ha|hecta)/i,
    en: /(?<n>\d[\d.,]*)\s*hectares?/i,
  },
];

/*
 * Well-known subjects — gives claims a `subject|predicate` identity instead
 * of predicate alone, so "Fed giữ lãi suất" and "NHNN giữ lãi suất" inside
 * one event resolve to two claims, not one flickering value.
 * P0 is a fixed map; entity resolution lands with the entities table in P1.
 */
const SUBJECT_HINTS: [RegExp, string][] = [
  [/\b(fed|fomc|federal reserve)\b/i, "Federal Reserve"],
  [/\b(nhnn|ngân hàng nhà nước|sbv)\b/i, "NHNN"],
  [/\becb\b/i, "ECB"],
  [/\b(boj|bank of japan)\b/i, "BoJ"],
  [/\bopec(?:\+)?\b/i, "OPEC"],
];

const slug = (s: string) => s.toLowerCase().replace(/\s+/g, "_");

/* vi: "1,5"=1.5 · "1.000"=1000 · "1.000,5"=1000.5
   en: "1.5"=1.5  · "1,000"=1000 · "1,000.5"=1000.5 */
function parseNumber(raw: string, lang: Lang): number | null {
  const t = raw.trim().replace(/\s/g, "");
  let n: number;
  if (lang === "en") {
    n = Number(t.replace(/,/g, ""));
  } else if (t.includes(",")) {
    n = Number(t.replace(/\./g, "").replace(",", "."));
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    n = Number(t.replace(/\./g, ""));
  } else {
    n = Number(t);
  }
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract numeric claims from every article in the cluster.
 * Same (source, key, value) observed twice is emitted once; the same key
 * asserted by different sources produces corroborating claim_evidence rows;
 * different values produce claim_versions — the diff IS the change log.
 */
export function extractClaims(cluster: StoryCluster): ExtractedClaim[] {
  const seen = new Set<string>();
  const out: ExtractedClaim[] = [];
  for (const a of cluster.articles) {
    const lang: Lang = a.language === "en" ? "en" : "vi";
    const text = `${a.title}. ${a.summary}`;
    const subject = SUBJECT_HINTS.find(([re]) => re.test(text))?.[1];
    const usedSpans: [number, number][] = [];
    for (const p of PATTERNS) {
      const re = lang === "en" ? p.en : p.vi;
      const m = re?.exec(text);
      if (!m) continue;
      // a generic pattern must not re-claim text a specific pattern took
      // (e.g. "thiệt hại 3 nghìn tỷ đồng" → damage_vnd, not money_vnd)
      const start = m.index;
      if (usedSpans.some(([s, e]) => start >= s && start < e)) continue;
      usedSpans.push([start, start + m[0].length]);
      const raw = m.groups?.n ?? m.groups?.n2;
      const lo = m.groups?.lo;
      const scaleKey = m.groups?.m ?? m.groups?.m2;
      const factor = scaleKey
        ? p.scale?.[scaleKey.trim().toLowerCase()]
        : undefined;
      const scaled = (n: number) =>
        factor ? Number((n * factor).toFixed(4)) : n;
      let value: unknown;
      let valueType: "number" | "range" = "number";
      if (lo != null && m.groups?.hi != null) {
        const low = parseNumber(lo, lang);
        const high = parseNumber(m.groups.hi, lang);
        if (low == null || high == null) continue;
        value = { low: scaled(low), high: scaled(high) };
        valueType = "range";
      } else {
        if (raw == null) continue;
        const num = parseNumber(raw, lang);
        if (num == null) continue;
        value = scaled(num);
      }
      const claimKey = subject ? `${slug(subject)}|${p.key}` : p.key;
      const dedup = `${a.source}|${claimKey}|${JSON.stringify(value)}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({
        claimKey,
        predicate: p.key,
        claimType: "numeric",
        valueType,
        value,
        unit: p.unit,
        qualifiers: subject ? { subject } : undefined,
        label: m[0].trim().replace(/\s+/g, " "),
        assertedBy: a.source,
      });
    }
  }
  return out;
}
