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

/* Typed exposure targets — an entity mentioned in a story is NOT an
 * asset exposure. Targets must declare what kind of exposure they are. */
export type TargetType =
  | "entity" /* a tracked entity — weak hint, not an asset */
  | "instrument" /* canonical instrument key, e.g. equity:HOSE:VNM */
  | "macro_factor" /* a macro series, e.g. fred:DGS10 */
  | "sector" /* a sector basket, e.g. vn:real_estate */
  | "country_exposure"; /* a country's broad asset complex */
export interface Target {
  type: TargetType;
  key: string;
}

export interface MaterialityAssessment {
  materiality: MaterialityLevel | "unknown";
  scope: Scope | null;
  channels: Channel[];
  directness: Directness | null;
  persistence: Persistence | null;
  horizon: Horizon | null;
  affectedTargets: Target[];
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

/* What a macro observation IS, physically — determines the lawful
 * transform before any abnormality claim. Z-scoring a trending level
 * (CPI index, payrolls, M2, S&P) manufactures fake "abnormality". */
export type SeriesMeasure =
  | "level_index" /* CPI/PCE index, IP index — transform to growth */
  | "rate_pct" /* yields, policy rates, spreads, unemployment — Δ in pp */
  | "price" /* FX, index level, commodity — log/pct return */
  | "stock" /* payrolls, M2, GDP level — Δ or %Δ */
  | "flow" /* retail sales, housing starts — %Δ */
  | "sentiment_index"; /* survey levels — Δ in points */

export type SeriesRole =
  | "decision" /* official policy rate the board sets (ECBDFR) */
  | "effective" /* market-determined within a corridor (FEDFUNDS) */
  | "market" /* yields, spreads, spot prices */
  | "release"; /* statistical releases */

/* The lawful abnormality transform — DECLARED per series, never inferred
 * from measure. PAYEMS is the canonical case: measure='stock' but the
 * economically meaningful surprise is Δ jobs, not %Δ of the stock. */
export type SeriesTransform = "diff" | "pct_change";

interface MacroMeta {
  cls: MacroClass;
  /** 'core' series move broad asset prices; 'context' informs but rarely
   * reprices on a single print; 'baseline' is annual forecast/census data */
  salience: "core" | "context" | "baseline";
  scope: Scope;
  measure: SeriesMeasure;
  role: SeriesRole;
  transform: SeriesTransform;
}

const FRED_MAP: Record<string, MacroMeta> = {
  /* FEDFUNDS is the EFFECTIVE overnight rate — a monthly average of a
   * market rate inside the corridor, not the FOMC target decision. A
   * step in it is an observation, never a "Fed decision" on its own. */
  FEDFUNDS: {
    cls: "policy_rate",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "effective",
    transform: "diff",
  },
  ECBDFR: {
    cls: "policy_rate",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "decision",
    transform: "diff",
  },
  DGS2: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  DGS10: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  T10Y2Y: {
    cls: "sovereign_yield",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  T10YIE: {
    cls: "inflation",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  CPIAUCSL: {
    cls: "inflation",
    salience: "core",
    scope: "global_systemic",
    measure: "level_index",
    role: "release",
    transform: "pct_change",
  },
  UNRATE: {
    cls: "labor",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "release",
    transform: "diff",
  },
  PAYEMS: {
    cls: "labor",
    salience: "core",
    scope: "global_systemic",
    measure: "stock",
    role: "release",
    transform: "diff",
  },
  GDPC1: {
    cls: "growth",
    salience: "core",
    scope: "global_systemic",
    measure: "stock",
    role: "release",
    transform: "pct_change",
  },
  INDPRO: {
    cls: "growth",
    salience: "context",
    scope: "global_systemic",
    measure: "level_index",
    role: "release",
    transform: "pct_change",
  },
  RSAFS: {
    cls: "growth",
    salience: "context",
    scope: "global_systemic",
    measure: "flow",
    role: "release",
    transform: "pct_change",
  },
  HOUST: {
    cls: "growth",
    salience: "context",
    scope: "global_systemic",
    measure: "flow",
    role: "release",
    transform: "pct_change",
  },
  UMCSENT: {
    cls: "sentiment",
    salience: "context",
    scope: "global_systemic",
    measure: "sentiment_index",
    role: "release",
    transform: "diff",
  },
  M2SL: {
    cls: "money_supply",
    salience: "context",
    scope: "global_systemic",
    measure: "stock",
    role: "release",
    transform: "pct_change",
  },
  WALCL: {
    cls: "money_supply",
    salience: "context",
    scope: "global_systemic",
    measure: "stock",
    role: "release",
    transform: "pct_change",
  },
  BAMLH0A0HYM2: {
    cls: "credit",
    salience: "core",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  VIXCLS: {
    cls: "risk_premium",
    salience: "core",
    scope: "global_systemic",
    measure: "level_index",
    role: "market",
    transform: "diff",
  },
  SP500: {
    cls: "risk_premium",
    salience: "core",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  DCOILWTICO: {
    cls: "commodity",
    salience: "core",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  DTWEXBGS: {
    cls: "fx",
    salience: "context",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  DEXUSEU: {
    cls: "fx",
    salience: "context",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  DEXJPUS: {
    cls: "fx",
    salience: "context",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  DEXCHUS: {
    cls: "fx",
    salience: "context",
    scope: "global_systemic",
    measure: "price",
    role: "market",
    transform: "pct_change",
  },
  PCEPILFE: {
    cls: "inflation",
    salience: "core",
    scope: "global_systemic",
    measure: "level_index",
    role: "release",
    transform: "pct_change",
  },
  MORTGAGE30US: {
    cls: "policy_rate",
    salience: "context",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "market",
    transform: "diff",
  },
  /* FRED annual CPI forecast series (FPCPITOTLZG<CC>) — annual levels of
   * the rate itself; still 'baseline' in practice via frequency='A' */
  FPCPITOTLZGGBR: {
    cls: "inflation",
    salience: "context",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "release",
    transform: "diff",
  },
  FPCPITOTLZGDEU: {
    cls: "inflation",
    salience: "context",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "release",
    transform: "diff",
  },
  FPCPITOTLZGJPN: {
    cls: "inflation",
    salience: "context",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "release",
    transform: "diff",
  },
  FPCPITOTLZGCHN: {
    cls: "inflation",
    salience: "context",
    scope: "global_systemic",
    measure: "rate_pct",
    role: "release",
    transform: "diff",
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
        measure: "level_index",
        role: "release",
        transform: "pct_change",
      }
    );
  /* 'VNM:NGDP_RPCH' / 'VNM:NY.GDP.MKTP.KD.ZG' — split country prefix */
  const country = seriesCode.split(":")[0];
  const code = seriesCode.split(":").slice(1).join(":");
  const scope: Scope = country === "VNM" ? "vietnam" : "global_systemic";
  const cls =
    (provider === "imf" ? IMF_INDICATOR[code] : WB_INDICATOR[code]) ?? "other";
  /* annual IMF/WB values are rates/growth percents or levels; they never
   * reach the abnormality path (salience='baseline' short-circuits) */
  return {
    cls,
    salience: "baseline",
    scope,
    measure: "rate_pct",
    role: "release",
    transform: "diff",
  };
}

/* ── lawful transforms ──────────────────────────────────────── */

interface TransformedObs {
  /** the current observation expressed in change-space */
  observed: number;
  /** trailing changes the observation is measured against */
  basis: number[];
  transform: SeriesTransform;
}

export function transformSeries(
  t: SeriesTransform,
  value: number,
  history: number[], // oldest → newest, EXCLUDING value
): TransformedObs | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  let observed: number;
  const basis: number[] = [];
  if (t === "diff") {
    observed = value - last;
    for (let i = 1; i < history.length; i++)
      basis.push(history[i] - history[i - 1]);
  } else {
    if (last === 0) return null;
    observed = ((value - last) / last) * 100;
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1] === 0) continue;
      basis.push(((history[i] - history[i - 1]) / history[i - 1]) * 100);
    }
  }
  return { observed, basis, transform: t };
}

/* As-of history builder — the only legal baseline for replay. Rows are
 * raw (obsDate, vintageDate, value); at vintage T only versions with
 * vintageDate ≤ T existed, and a revision landed at T+30 must never leak
 * into the score of the T print. */
export interface MacroPointRow {
  obsDate: string;
  vintageDate: string;
  value: number;
}

export function asOfSeriesHistory(
  rows: MacroPointRow[],
  targetObsDate: string,
  targetVintageDate: string,
): number[] {
  const latest = new Map<string, { vintageDate: string; value: number }>();
  for (const r of rows) {
    if (r.obsDate >= targetObsDate) continue;
    if (r.vintageDate > targetVintageDate) continue;
    const cur = latest.get(r.obsDate);
    if (!cur || r.vintageDate > cur.vintageDate)
      latest.set(r.obsDate, { vintageDate: r.vintageDate, value: r.value });
  }
  return [...latest.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, v]) => v.value);
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
  const target: Target = {
    type: "macro_factor",
    key: `${i.provider}:${i.seriesCode}`,
  };

  /* the required distinction: this release is an observation change.
   * abnormality is measured against the series' own history IN
   * CHANGE-SPACE — z-scoring a trending level (CPI index, payrolls, M2)
   * manufactures fake abnormality. consensus surprise remains IMPOSSIBLE
   * — no expectations data exists. */
  const tr = transformSeries(meta.transform, i.value, i.history);
  const az = tr ? absZ(tr.observed, tr.basis) : null;

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

  /* discrete policy-rate steps: only a series that IS the official
   * decision instrument can mint a "policy decision" — ECBDFR is set by
   * the governing council; FEDFUNDS is an effective market average and a
   * step in it is an observation, not a decision. The step is measured as
   * the transformed current move (value minus last as-of observation) —
   * never via prev_macro_version_id, which is an ingest linkage, not the
   * previous-period observation. */
  const decisionStep =
    meta.transform === "diff" && i.history.length >= 1
      ? i.value - i.history[i.history.length - 1]
      : null;
  if (
    meta.role === "decision" &&
    decisionStep != null &&
    Math.abs(decisionStep) >= 0.1 &&
    i.frequency !== "D" /* daily prints can't carry a decision */
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
      reason: `policy rate step ${decisionStep >= 0 ? "+" : ""}${decisionStep.toFixed(2)}pp`,
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
      az == null || tr == null
        ? "release, no history baseline"
        : `${tr.transform === "diff" ? "Δ" : "pct"} ${tr.observed >= 0 ? "+" : ""}${tr.observed.toFixed(2)}${tr.transform === "pct_change" ? "%" : "pp"} — |z|=${az.toFixed(2)} of own changes`,
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
  /* dividend yield is only meaningful against a price that existed when
   * the action did — 'pre_ex' = last close strictly before ex-date.
   * 'latest' is a look-ahead mismatch and must be flagged, never used
   * silently. */
  referencePrice: number | null;
  priceBasis: "pre_ex" | "latest" | "none";
  /* as_traded is the only convention lawful for historical yield —
   * provider_adjusted prices embed split/dividend adjustments and can be
   * wildly wrong years later */
  priceConvention?: "as_traded" | "provider_adjusted" | "quoted" | null;
  /* currency of the reference price — must equal `currency` for yield
   * math. Unknown on either side → unverified, no upgrade. */
  priceCurrency?: string | null;
  exDate: string | null;
  splitFactor: number | null; // split_to / split_from
}

export function scoreCorporateAction(
  i: CorporateActionInput,
): MaterialityAssessment {
  const targets: Target[] = [{ type: "instrument", key: i.instrumentKey }];
  const cautions: string[] = [];
  if (i.priceBasis === "latest") cautions.push("lookahead_price");
  if (i.priceBasis === "none") cautions.push("no_price_context");
  const currencyVerified =
    i.currency != null &&
    i.priceCurrency != null &&
    i.currency === i.priceCurrency;
  if (!currencyVerified)
    cautions.push(
      i.currency == null || i.priceCurrency == null
        ? "currency_unverified"
        : "currency_mismatch",
    );
  if (i.priceConvention != null && i.priceConvention !== "as_traded")
    cautions.push("price_convention_unverified");

  /* provider semantics guard: a per-share 'cash' amount at/above the
   * share price is not a dividend — it's a misrecorded distribution
   * (e.g. share-class spinoff value). Magnitude unusable → limited. */
  const absurdAmount =
    i.cashAmount != null &&
    i.referencePrice != null &&
    i.referencePrice > 0 &&
    i.cashAmount >= i.referencePrice;
  if (absurdAmount) cautions.push("provider_magnitude_unverified");
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
      cautions: ["mechanical_no_value_change", ...cautions],
    };
  }
  let level: MaterialityLevel;
  if (absurdAmount) {
    level = "limited";
  } else if (i.cashAmount == null) {
    level = "limited";
    cautions.push("no_cash_amount");
  } else if (i.referencePrice == null || i.referencePrice <= 0) {
    level = "limited";
    cautions.push("no_price_context");
  } else if (
    i.priceBasis !== "pre_ex" ||
    i.priceConvention !== "as_traded" ||
    !currencyVerified
  ) {
    /* without a time-consistent, as-traded, same-currency price the
     * yield is unverifiable — never silently divide two numbers */
    level = "limited";
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
      i.cashAmount != null &&
      i.referencePrice &&
      i.priceBasis === "pre_ex" &&
      i.priceConvention === "as_traded" &&
      currencyVerified
        ? `dividend yield ~${((i.cashAmount / i.referencePrice) * 100).toFixed(1)}% vs pre-ex close`
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
  /* instrument semantics, not asset_class: a VN index arrives with
   * asset_class='equity' + instrument_type='index' — it is never
   * 'issuer'-scoped. */
  const vnIndex = /(:|^)(HOSE|HNX|UPCOM|VN)(:|$)|VNINDEX|VN30|HNX/i.test(
    i.instrumentKey,
  );
  return {
    materiality: level,
    scope: i.isIndex
      ? vnIndex
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
    affectedTargets: [{ type: "instrument", key: i.instrumentKey }],
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
  policy_rate: ["discounting", "funding_liquidity"],
  rate_cut: ["discounting", "funding_liquidity"],
  rate_hike: ["discounting", "funding_liquidity"],
  sanctions: ["policy_regulatory", "external"],
  tariff_imposition: ["policy_regulatory", "external"],
  tariff_rate: ["policy_regulatory", "external"],
  tariff_increase: ["policy_regulatory", "external"],
  tariff_hike: ["policy_regulatory", "external"],
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
  dividend_declaration: ["fundamental"],
  bank_failure: ["funding_liquidity"],
  deposit_guarantee: ["funding_liquidity"],
  supply_chain_disruption: ["fundamental", "external"],
  oil_supply_disruption: ["external", "fundamental"],
  lockdown: ["policy_regulatory"],
  economic_shutdown: ["fundamental", "policy_regulatory"],
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

export interface EventEntity {
  slug: string;
  /** ontology type: country|company|central_bank|person|… */
  type: string;
}

export interface EventMaterialityInput {
  predicates: string[];
  /** entities attached to the event with their ontology types */
  entities: EventEntity[];
  /** 'vietnam'|'world'|… */
  topic: string;
  /* R6 evidence stats are intentionally NOT inputs — a wire copy count
   * can never raise intrinsic materiality. */
}

export function scoreEventMateriality(
  i: EventMaterialityInput,
): MaterialityAssessment {
  const entityTypes = [...new Set(i.entities.map((e) => e.type))];
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
  for (const t of entityTypes) {
    const lift = SCOPE_LIFTING[t];
    if (lift && scopeRank(lift) > scopeRank(scope)) scope = lift;
  }
  if (
    entityTypes.includes("company") &&
    !entityTypes.some((t) => t in SCOPE_LIFTING || t === "country")
  )
    scope = "issuer";

  /* 'major' needs corroborating structure. Predicates on a fused event are
   * noisy, so the bar is: ≥2 distinct INSTRUMENT families (a tariff claim
   * plus sanctions is evidence; five spellings of the same tariff claim
   * are not), or ≥1 instrument hitting a discounting/funding channel.
   * Disbursement-family hits inside war/conflict context are aid
   * accounting, not credit conditions — capped 'limited'. */
  /* each real instrument is its own family — 'sanctions' and
   * 'interest_rate' are different levers; 5 spellings of one tariff are
   * not. */
  const family = (p: string) =>
    p.startsWith("tariff") ||
    p === "trade_agreement" ||
    p === "export_regulation_change" ||
    p === "trade_truce_extension"
      ? "trade"
      : p.startsWith("sanction")
        ? "sanctions"
        : p.startsWith("interest_rate") || p === "policy_rate"
          ? "rate"
          : p === "foreign_direct_investment"
            ? "fdi"
            : p === "policy_approved"
              ? "policy"
              : p === "net_profit"
                ? "earnings"
                : p;
  const hard = hits.filter((p) => !SOFT_FAMILY.has(p));
  const hardFamilies = new Set(hard.map(family));
  const hardCh = new Set(hard.flatMap((p) => PREDICATE_CHANNELS[p]));
  const warCtx = i.predicates.some((p) => WAR_CONTEXT.test(p));
  const lifted = entityTypes.some((t) => t in SCOPE_LIFTING);
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
    /* mention ≠ exposure: emit typed targets only where a channel exists,
     * and only country entities become country_exposure. Companies and
     * people stay 'entity' hints — resolving them to instruments is the
     * exposure graph's job (R7.2), not this baseline's. */
    affectedTargets:
      channels.size === 0
        ? []
        : i.entities
            .filter((e) => e.type === "country")
            .slice(0, 4)
            .map((e) => ({ type: "country_exposure" as const, key: e.slug })),
    transmissionConfidence: "low",
    reason: `predicate signal: ${hits.join(",")}`,
    cautions: ["predicate_baseline_only", "entity_mentions_not_exposure"],
  };
}

function scopeRank(s: Scope): number {
  return ["issuer", "sector", "vietnam", "global_systemic"].indexOf(s);
}
