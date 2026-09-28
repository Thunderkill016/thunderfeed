/* R7.0 Materiality — deterministic baseline scorer for the Quality Lab.
 *
 * Pure functions only: given a candidate's structured fields, produce a
 * rubric-shaped assessment (docs/materiality-rubric.md). This is the
 * FLOOR — the bar any later engine or AI proposal must beat. It never
 * asserts market direction and never upgrades materiality because many
 * outlets repeated the same report.
 */

export type MaterialityLevel =
  "none" | "limited" | "meaningful" | "major" | "systemic";
export type Channel =
  | "fundamental"
  | "discounting"
  | "funding_liquidity"
  | "external"
  | "policy_regulatory";
export type Scope = "issuer" | "sector" | "vietnam" | "global_systemic";
export type Directness =
  "direct" | "first_order" | "second_order" | "speculative";
export type Persistence = "transient" | "cyclical" | "structural";
export type Horizon = "immediate" | "weeks" | "months" | "long_term";

export interface MaterialityAssessment {
  materiality: MaterialityLevel | "unknown";
  scope: Scope | null;
  channels: Channel[];
  directness: Directness | null;
  persistence: Persistence | null;
  horizon: Horizon | null;
  affectedTargets: string[];
  transmissionConfidence: "low" | "medium" | "high" | null;
  /** which rule path produced this — audit, not display copy */
  reason: string;
  cautions: string[];
}

const LEVEL_RANK: MaterialityLevel[] = [
  "none",
  "limited",
  "meaningful",
  "major",
  "systemic",
];
function cap(
  level: MaterialityLevel,
  ceiling: MaterialityLevel,
): MaterialityLevel {
  return LEVEL_RANK.indexOf(level) > LEVEL_RANK.indexOf(ceiling)
    ? ceiling
    : level;
}

/* ── macro series classification ────────────────────────────── */

export type MacroClass =
  | "policy_rate"
  | "sovereign_yield"
  | "inflation"
  | "growth"
  | "labor"
  | "fx"
  | "credit"
  | "risk_premium"
  | "commodity"
  | "money_supply"
  | "sentiment"
  | "external_trade"
  | "fiscal"
  | "demographics"
  | "other";

interface MacroMeta {
  cls: MacroClass;
  /** 'core' series move broad asset prices; 'context' informs but rarely
   * reprices on a single print; 'baseline' is annual forecast/census data */
  salience: "core" | "context" | "baseline";
  scope: Scope;
}

const FRED_MAP: Record<string, MacroMeta> = {
  FEDFUNDS: { cls: "policy_rate", salience: "core", scope: "global_systemic" },
  ECBDFR: { cls: "policy_rate", salience: "core", scope: "global_systemic" },
  DGS2: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
  },
  DGS10: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
  },
  T10Y2Y: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
  },
  T10YIE: { cls: "inflation", salience: "core", scope: "global_systemic" },
  CPIAUCSL: { cls: "inflation", salience: "core", scope: "global_systemic" },
  UNRATE: { cls: "labor", salience: "core", scope: "global_systemic" },
  PAYEMS: { cls: "labor", salience: "core", scope: "global_systemic" },
  GDPC1: { cls: "growth", salience: "core", scope: "global_systemic" },
  INDPRO: { cls: "growth", salience: "context", scope: "global_systemic" },
  RSAFS: { cls: "growth", salience: "context", scope: "global_systemic" },
  HOUST: { cls: "growth", salience: "context", scope: "global_systemic" },
  UMCSENT: { cls: "sentiment", salience: "context", scope: "global_systemic" },
  M2SL: {
    cls: "money_supply",
    salience: "context",
    scope: "global_systemic",
  },
  WALCL: {
    cls: "money_supply",
    salience: "context",
    scope: "global_systemic",
  },
  BAMLH0A0HYM2: {
    cls: "credit",
    salience: "core",
    scope: "global_systemic",
  },
  VIXCLS: { cls: "risk_premium", salience: "core", scope: "global_systemic" },
  SP500: { cls: "risk_premium", salience: "core", scope: "global_systemic" },
  DCOILWTICO: { cls: "commodity", salience: "core", scope: "global_systemic" },
  DTWEXBGS: { cls: "fx", salience: "context", scope: "global_systemic" },
  DEXUSEU: { cls: "fx", salience: "context", scope: "global_systemic" },
  DEXJPUS: { cls: "fx", salience: "context", scope: "global_systemic" },
  DEXCHUS: { cls: "fx", salience: "context", scope: "global_systemic" },
  MORTGAGE30US: {
    cls: "policy_rate",
    salience: "context",
    scope: "global_systemic",
  },
};

/* IMF `CCY:INDICATOR` and WorldBank `CCY:WB.CODE` codes — all annual,
 * all macro fundamentals. They are baseline/forecast context, not
 * breaking signals. */
const IMF_INDICATOR: Record<string, MacroClass> = {
  NGDP_RPCH: "growth",
  PCPIPCH: "inflation",
  LUR: "labor",
  BCA_NGDPD: "external_trade",
  GGXWDG_NGDP: "fiscal",
  NGSD_NGDP: "fiscal",
  NID_NGDP: "growth",
  NGDPDPC: "growth",
};
const WB_INDICATOR: Record<string, MacroClass> = {
  "NY.GDP.MKTP.KD.ZG": "growth",
  "NY.GDP.MKTP.CD": "growth",
  "FP.CPI.TOTL.ZG": "inflation",
  "SL.UEM.TOTL.ZS": "labor",
  "NE.EXP.GNFS.ZS": "external_trade",
  "BX.KLT.DINV.WD.GD.ZS": "external_trade",
  "SP.POP.TOTL": "demographics",
};

const CHANNEL_BY_CLASS: Record<MacroClass, Channel[]> = {
  policy_rate: ["discounting", "funding_liquidity"],
  sovereign_yield: ["discounting"],
  inflation: ["discounting", "fundamental"],
  growth: ["fundamental", "discounting"],
  labor: ["fundamental", "discounting"],
  fx: ["external"],
  credit: ["funding_liquidity"],
  risk_premium: ["discounting", "external"],
  commodity: ["external", "fundamental"],
  money_supply: ["funding_liquidity"],
  sentiment: ["fundamental"],
  external_trade: ["external"],
  fiscal: ["policy_regulatory", "fundamental"],
  demographics: [],
  other: [],
};

export function classifyMacroSeries(
  provider: string,
  seriesCode: string,
): MacroMeta {
  if (provider === "fred")
    return (
      FRED_MAP[seriesCode] ?? {
        cls: "other",
        salience: "context",
        scope: "global_systemic",
      }
    );
  /* 'VNM:NGDP_RPCH' / 'VNM:NY.GDP.MKTP.KD.ZG' — split country prefix */
  const country = seriesCode.split(":")[0];
  const code = seriesCode.split(":").slice(1).join(":");
  const scope: Scope = country === "VNM" ? "vietnam" : "global_systemic";
  const cls =
    (provider === "imf" ? IMF_INDICATOR[code] : WB_INDICATOR[code]) ?? "other";
  return { cls, salience: "baseline", scope };
}

/* ── macro release/delta scoring ────────────────────────────── */

export interface MacroDeltaInput {
  provider: string;
  seriesCode: string;
  frequency: string | null;
  kind: "macro_release" | "macro_revision";
  value: number;
  prevValue: number | null;
  /** trailing values of the same series, oldest→newest EXCLUDING value */
  history: number[];
}

export function scoreMacroDelta(i: MacroDeltaInput): MaterialityAssessment {
  const meta = classifyMacroSeries(i.provider, i.seriesCode);
  const channels = CHANNEL_BY_CLASS[meta.cls];
  const cautions: string[] = [];
  const target = `macro:${i.provider}:${i.seriesCode}`;

  /* the required distinction: this release is an observation change.
   * abnormality is measured against the series' own history; consensus
   * surprise is IMPOSSIBLE — no expectations data exists. */
  const az = absZ(i.value, i.history);
  const absMove = i.prevValue == null ? null : Math.abs(i.value - i.prevValue);

  if (meta.salience === "baseline" || i.frequency === "A") {
    cautions.push("annual_forecast_baseline");
    return {
      materiality: "limited",
      scope: meta.scope,
      channels,
      directness: "second_order",
      persistence: "structural",
      horizon: "months",
      affectedTargets: meta.scope === "vietnam" ? [target] : [],
      transmissionConfidence: "low",
      reason: "annual/forecast series — baseline context, not a signal",
      cautions,
    };
  }

  /* discrete policy-rate steps: any nontrivial step is a decision, not
   * drift — FEDFUNDS/ECBDFR moves are stepwise so |Δ| ≥ 10bp is 'major' */
  if (
    meta.cls === "policy_rate" &&
    absMove != null &&
    absMove >= 0.1 &&
    i.frequency !== "D" /* daily effective-rate noise is not a decision */
  ) {
    return {
      materiality: "major",
      scope: meta.scope,
      channels,
      directness: "direct",
      persistence: "cyclical",
      horizon: "months",
      affectedTargets: [target],
      transmissionConfidence: "high",
      reason: `policy rate step ${absMove.toFixed(2)}`,
      cautions,
    };
  }

  if (i.kind === "macro_revision") {
    cautions.push("revision");
    return {
      materiality: cap(
        meta.salience === "core" && az != null && az >= 2
          ? "meaningful"
          : "limited",
        "meaningful",
      ),
      scope: meta.scope,
      channels,
      directness: "second_order",
      persistence: "cyclical",
      horizon: "months",
      affectedTargets: [target],
      transmissionConfidence: "medium",
      reason: "vintage revision of a known print",
      cautions,
    };
  }

  let level: MaterialityLevel;
  if (az == null) {
    /* no usable history — a release is an observation, abnormality
     * unproven */
    level = "limited";
    cautions.push("insufficient_history");
  } else if (az >= 2.5) {
    level = meta.salience === "core" ? "major" : "meaningful";
  } else if (az >= 1.5) {
    level = meta.salience === "core" ? "meaningful" : "limited";
  } else {
    level = "limited";
  }

  return {
    materiality: level,
    scope: meta.scope,
    channels,
    directness: "direct",
    persistence: "cyclical",
    horizon: "weeks",
    affectedTargets: [target],
    transmissionConfidence:
      level === "major" ? "high" : level === "meaningful" ? "medium" : "low",
    reason:
      az == null
        ? "release, no history baseline"
        : `|z|=${az.toFixed(2)} vs own history`,
    cautions,
  };
}

function absZ(value: number, history: number[]): number | null {
  if (history.length < 8) return null;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(
    history.reduce((a, b) => a + (b - mean) ** 2, 0) / (history.length - 1),
  );
  if (sd === 0) return null;
  return Math.abs(value - mean) / sd;
}

/* ── corporate action scoring ───────────────────────────────── */

export interface CorporateActionInput {
  actionType: "cash_dividend" | "stock_split";
  instrumentKey: string; // e.g. 'equity:HOSE:VNM'
  cashAmount: number | null;
  currency: string | null;
  referencePrice: number | null; // latest close, same currency
  splitFactor: number | null; // split_to / split_from
}

export function scoreCorporateAction(
  i: CorporateActionInput,
): MaterialityAssessment {
  const targets = [i.instrumentKey];
  if (i.actionType === "stock_split") {
    const extreme =
      i.splitFactor != null && (i.splitFactor >= 5 || i.splitFactor <= 0.2);
    return {
      materiality: extreme ? "meaningful" : "limited",
      scope: "issuer",
      channels: [], // a split is mechanical — no cash-flow channel
      directness: "direct",
      persistence: "transient",
      horizon: "immediate",
      affectedTargets: targets,
      transmissionConfidence: "high",
      reason: "split changes units, not value",
      cautions: ["mechanical_no_value_change"],
    };
  }
  const cautions: string[] = [];
  let level: MaterialityLevel;
  if (i.cashAmount == null) {
    level = "limited";
    cautions.push("no_cash_amount");
  } else if (i.referencePrice == null || i.referencePrice <= 0) {
    level = "limited";
    cautions.push("no_price_context");
  } else {
    const y = (i.cashAmount / i.referencePrice) * 100;
    level = y >= 5 ? "meaningful" : y >= 2 ? "meaningful" : "limited";
  }
  return {
    materiality: level,
    scope: "issuer",
    channels: ["fundamental"],
    directness: "direct",
    persistence: "transient",
    horizon: "weeks",
    affectedTargets: targets,
    transmissionConfidence: "high",
    reason:
      i.cashAmount != null && i.referencePrice
        ? `dividend yield ~${((i.cashAmount / i.referencePrice) * 100).toFixed(1)}%`
        : "dividend, magnitude unpriced",
    cautions,
  };
}

/* ── market move scoring ────────────────────────────────────── */

export interface MarketMoveInput {
  instrumentKey: string;
  assetClass: "equity" | "commodity" | "crypto" | "fx" | "index";
  /** % change close-to-close, e.g. -1.8 */
  pctChange: number;
  /** stdev of trailing daily % changes for the same series */
  trailingVol: number | null;
  isIndex: boolean;
}

export function scoreMarketMove(i: MarketMoveInput): MaterialityAssessment {
  const z =
    i.trailingVol != null && i.trailingVol > 0
      ? Math.abs(i.pctChange) / i.trailingVol
      : null;
  let level: MaterialityLevel;
  if (z == null) {
    level = Math.abs(i.pctChange) >= (i.isIndex ? 2 : 4) ? "limited" : "none";
  } else if (z >= 4) {
    level = "meaningful";
  } else if (z >= 2.5) {
    level = i.isIndex || i.assetClass !== "equity" ? "meaningful" : "limited";
  } else {
    level = "limited";
  }
  return {
    materiality: level,
    scope:
      i.assetClass === "index"
        ? i.instrumentKey.includes("VN")
          ? "vietnam"
          : "global_systemic"
        : i.assetClass === "equity"
          ? "issuer"
          : "global_systemic",
    /* a market move PROVES a reaction happened — it says nothing about
     * why. Channels stay empty on purpose. */
    channels: [],
    directness: "direct",
    persistence: "transient",
    horizon: "immediate",
    affectedTargets: [i.instrumentKey],
    transmissionConfidence: null,
    reason:
      z == null
        ? `move ${i.pctChange.toFixed(2)}% without vol baseline`
        : `move ${i.pctChange.toFixed(2)}% ≈ ${z.toFixed(1)}σ of own vol`,
    cautions: ["reaction_not_cause"],
  };
}

/* ── news event scoring (v1 — honest unknown) ───────────────── */

/* Only predicates whose economic channel is unambiguous map. Anything
 * else → 'unknown': v1 never forces a classification off a noisy
 * predicate vocabulary. */
const PREDICATE_CHANNELS: Record<string, Channel[]> = {
  interest_rate: ["discounting", "funding_liquidity"],
  sanctions: ["policy_regulatory", "external"],
  tariff_reduction: ["policy_regulatory", "external"],
  tariff_reduction_value: ["policy_regulatory", "external"],
  tariff_cut: ["policy_regulatory", "external"],
  tariff_cut_value: ["policy_regulatory", "external"],
  tariff_agreement: ["policy_regulatory", "external"],
  tariff_truce_extension: ["policy_regulatory", "external"],
  tariff_preferences: ["policy_regulatory", "external"],
  trade_agreement: ["external", "policy_regulatory"],
  export_regulation_change: ["policy_regulatory", "external"],
  policy_approved: ["policy_regulatory"],
  fund_disbursement: ["funding_liquidity"],
  disbursement: ["funding_liquidity"],
  disburse_funds: ["funding_liquidity"],
  financial_disbursement: ["funding_liquidity"],
  /* aid is a fiscal/external transfer, NOT a credit-conditions signal —
   * mapping it to funding_liquidity inflates war/diplomacy noise */
  aid_disbursement: ["external"],
  aid_disbursed: ["external"],
  military_aid_disbursement: ["external"],
  ukraine_aid_disbursement: ["external"],
  aid_package_disbursed: ["external"],
  foreign_direct_investment: ["external", "fundamental"],
  debt_to_gdp: ["policy_regulatory", "funding_liquidity"],
  net_profit: ["fundamental"],
  stock_index: [],
  stock_index_change: [],
  price_change: [],
  price: [],
};

/* Entity types that lift scope — a central bank or government action is
 * never 'issuer'-scoped trivia. */
const SCOPE_LIFTING: Record<string, Scope> = {
  central_bank: "global_systemic",
  government_body: "vietnam",
  multilateral_organization: "global_systemic",
};

/* Predicates that positively indicate a non-economic event — casualties,
 * crime, sport, weather damage. Used to distinguish 'none' (confidently
 * non-economic) from 'unknown' (can't tell). */
/* Disbursement/aid-family predicates map to funding/external in
 * isolation, but on conflict events they are aid accounting — soft
 * evidence that cannot justify 'major' by itself. */
const SOFT_FAMILY = new Set([
  "fund_disbursement",
  "disbursement",
  "disburse_funds",
  "financial_disbursement",
  "debt_to_gdp",
  "aid_disbursement",
  "aid_disbursed",
  "military_aid_disbursement",
  "ukraine_aid_disbursement",
  "aid_package_disbursed",
  "military_aid",
  "military_aid_approved",
  "military_aid_allocation",
  "aid_allocation",
  "military_aid_disbursed",
  "disburse_aid",
  "aid_package",
]);

/* conflict context — when these are present, aid/disbursement claims are
 * war accounting, not a financial-conditions signal */
const WAR_CONTEXT =
  /^(deaths|injured|casualties|fatalities|missing|evacuated|arrest|arrests|missile|uav|drone|ceasefire|airstrike|military_|weapon|troop|territor|bomb|attack|conflict_|survived_)/;

const NONECONOMIC_PREDICATES = new Set([
  "deaths",
  "injured",
  "missing",
  "arrest",
  "arrests",
  "sentence_years",
  "charges",
  "victims",
  "evacuated",
  "match_result",
  "medal",
  "gold_medals",
  "tournament_stage",
  "rank",
  "score",
  "casualties",
  "fatalities",
  "rescue",
  "damage_area_ha",
  "area_ha",
]);

export interface EventMaterialityInput {
  predicates: string[];
  /** entity types attached to the event, e.g. 'company','country' */
  entityTypes: string[];
  /** canonical entity slugs — used for target hints only */
  entitySlugs: string[];
  /** 'vietnam'|'world'|… */
  topic: string;
  /* R6 evidence stats are intentionally NOT inputs — a wire copy count
   * can never raise intrinsic materiality. */
}

export function scoreEventMateriality(
  i: EventMaterialityInput,
): MaterialityAssessment {
  const channels = new Set<Channel>();
  const hits: string[] = [];
  for (const p of i.predicates) {
    const ch = PREDICATE_CHANNELS[p];
    if (ch === undefined || ch.length === 0) continue;
    hits.push(p);
    for (const c of ch) channels.add(c);
  }
  if (!hits.length) {
    /* clearly non-economic events (sports, casualties, crime) are 'none',
     * not 'unknown' — positive non-economic signals let us state that
     * confidently. genuinely ambiguous content stays 'unknown'. */
    const econAdjacent = i.predicates.filter(
      (p) => !NONECONOMIC_PREDICATES.has(p),
    );
    const clearlyNonEconomic =
      i.topic === "sports" ||
      (i.predicates.length > 0 && econAdjacent.length === 0);
    if (clearlyNonEconomic) {
      return {
        materiality: "none",
        scope: null,
        channels: [],
        directness: null,
        persistence: null,
        horizon: null,
        affectedTargets: [],
        transmissionConfidence: null,
        reason: "no economic predicate and topic/entities are non-economic",
        cautions: ["predicate_not_materiality"],
      };
    }
    return {
      materiality: "unknown",
      scope: null,
      channels: [],
      directness: null,
      persistence: null,
      horizon: null,
      affectedTargets: [],
      transmissionConfidence: null,
      reason: "no high-precision predicate → unknown is the honest label",
      cautions: ["predicate_not_materiality"],
    };
  }

  /* scope = the broadest jurisdiction that a lifting entity implies;
   * a lone-company event stays issuer-scoped */
  let scope: Scope = i.topic === "vietnam" ? "vietnam" : "global_systemic";
  for (const t of i.entityTypes) {
    const lift = SCOPE_LIFTING[t];
    if (lift && scopeRank(lift) > scopeRank(scope)) scope = lift;
  }
  if (
    i.entityTypes.includes("company") &&
    !i.entityTypes.some((t) => t in SCOPE_LIFTING || t === "country")
  )
    scope = "issuer";

  /* 'major' needs corroborating structure. Predicates on a fused event are
   * noisy, so the bar is: ≥2 distinct INSTRUMENT families (a tariff claim
   * plus sanctions is evidence; five spellings of the same tariff claim
   * are not), or ≥1 instrument hitting a discounting/funding channel.
   * Disbursement-family hits inside war/conflict context are aid
   * accounting, not credit conditions — capped 'limited'. */
  const family = (p: string) =>
    p.startsWith("tariff") ||
    p === "trade_agreement" ||
    p === "export_regulation_change"
      ? "trade"
      : "other";
  const hard = hits.filter((p) => !SOFT_FAMILY.has(p));
  const hardFamilies = new Set(hard.map(family));
  const hardCh = new Set(hard.flatMap((p) => PREDICATE_CHANNELS[p]));
  const warCtx = i.predicates.some((p) => WAR_CONTEXT.test(p));
  const lifted = i.entityTypes.some((t) => t in SCOPE_LIFTING);
  const big =
    hardFamilies.size >= 2 ||
    /* a discounting hit IS the decision (rate/yield) — no corroboration
     * needed; funding alone still wants a second instrument */
    hardCh.has("discounting") ||
    (hard.length >= 2 && hardCh.has("funding_liquidity")) ||
    (lifted && hardFamilies.size >= 1 && hits.length >= 3);
  let level: MaterialityLevel =
    scope === "issuer" ? "meaningful" : big ? "major" : "meaningful";
  /* on conflict events, sanctions/aid claims are the background noise of
   * war coverage — only a real discounting channel escapes the cap */
  if (warCtx && !hardCh.has("discounting"))
    level = cap(level, hard.length === 0 ? "limited" : "meaningful");
  return {
    materiality: level,
    scope,
    channels: [...channels],
    directness: "first_order",
    persistence: "cyclical",
    horizon: "weeks",
    affectedTargets: i.entitySlugs,
    transmissionConfidence: "low",
    reason: `predicate signal: ${hits.join(",")}`,
    cautions: ["predicate_baseline_only"],
  };
}

function scopeRank(s: Scope): number {
  return ["issuer", "sector", "vietnam", "global_systemic"].indexOf(s);
}
