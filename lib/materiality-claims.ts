/* R7.1a Claim-Level Materiality — deterministic claim scorer for the
 * Quality Lab. Semantics first, storage later.
 *
 * The unit of reasoning is a logical CLAIM, not a raw predicate and not an
 * event predicate-bag. Truth adjudication stays in R6 — this module reads
 * claim state, never re-decides it. Three dimensions stay independent:
 *   evidence confidence ≠ transmission confidence ≠ materiality.
 *
 * A disputed claim about a 100bp Fed hike is still potentially systemic;
 * its transmission confidence is capped, its magnitude is not.
 */

import type {
  Channel,
  Directness,
  Horizon,
  MaterialityAssessment,
  MaterialityLevel,
  Persistence,
  Scope,
  Target,
} from "./materiality";

const LEVEL_RANK: (MaterialityLevel | "unknown")[] = [
  "none",
  "limited",
  "meaningful",
  "major",
  "systemic",
];

function cap<T extends MaterialityLevel>(level: T, ceiling: MaterialityLevel) {
  return (
    LEVEL_RANK.indexOf(level) > LEVEL_RANK.indexOf(ceiling) ? ceiling : level
  ) as MaterialityLevel;
}

/* ── input contract ─────────────────────────────────────────── */

export type ClaimState =
  | "confirmed"
  | "supported"
  | "reported"
  | "disputed"
  | "corrected"
  | "retracted"
  | "unresolved";

export interface ClaimMaterialityInput {
  claimId: string;
  predicate: string;
  claimType: string | null;
  current: {
    versionId: string;
    value: unknown;
    valueType: string | null;
    unit: string | null;
    qualifiers: Record<string, unknown> | null;
    state: ClaimState;
    validFrom: string | null;
  };
  previous?: {
    versionId: string;
    value: unknown;
    unit: string | null;
  } | null;
  subject: {
    entityId?: string | null;
    canonicalKey?: string | null;
    /** entity_type from entities table: 'country', 'company', 'person'… */
    type?: string | null;
    countryCode?: string | null;
    /** qualifiers.subject text fallback when entityId is NULL */
    qualifierText?: string | null;
  };
  evidence: {
    claimState: ClaimState;
    /** distinct root SOURCES whose latest relation is 'original' — R6
     * effectiveRoots semantics, never a COUNT of cached origin ids */
    confirmedIndependentOrigins: number;
    /** distinct root sources whose source.kind = 'primary' */
    primaryOrigins: number;
    /** docs with no lineage / 'unknown' / dangling derivation */
    unresolvedOrigins: number;
    derivedDocuments: number;
    /** every attached outlet — coverage, not independence */
    rawSourceCount: number;
  };
}

/* ── economic action ontology v1 ────────────────────────────── */

export type EconomicActionType =
  | "monetary_policy_change"
  | "interest_rate_observation"
  | "tariff_change"
  | "trade_agreement"
  | "sanction_change"
  | "export_regulation_change"
  | "fiscal_spending"
  | "fund_disbursement"
  | "debt_change"
  | "investment_commitment"
  | "corporate_profit_change"
  | "corporate_action"
  | "economic_indicator_change"
  | "credit_liquidity_shock"
  | "banking_stress"
  | "unknown_economic_action"
  | "non_economic";

export type ActionDirection =
  "increase" | "decrease" | "impose" | "remove" | "unchanged";

export interface EconomicAction {
  type: EconomicActionType;
  actor: string | null;
  affectedJurisdiction: string | null; // country code when resolvable
  magnitude: number | null;
  magnitudeUnit: string | null;
  direction: ActionDirection | null;
  confidence: "low" | "medium" | "high";
  sourceClaimVersionId: string;
}

/* ── predicate → action map ─────────────────────────────────── */

interface PredicateSpec {
  action: EconomicActionType;
  /** default direction when no prev/current delta exists */
  direction?: ActionDirection;
  /** unit the numeric value is expressed in for magnitude thresholds */
  magnitudeUnit?: string;
}

/** Vietnamese+English predicate spellings seen in prod. Unlisted economic-ish
 * predicates fall through to `unknown_economic_action` — never guessed. */
const PREDICATE_ACTIONS: Record<string, PredicateSpec> = {
  // monetary
  interest_rate: { action: "monetary_policy_change", magnitudeUnit: "percent" },
  policy_rate: { action: "monetary_policy_change", magnitudeUnit: "percent" },
  base_rate: { action: "monetary_policy_change", magnitudeUnit: "percent" },
  refinancing_rate: {
    action: "monetary_policy_change",
    magnitudeUnit: "percent",
  },
  deposit_rate_cap: {
    action: "monetary_policy_change",
    magnitudeUnit: "percent",
  },
  exchange_rate: { action: "interest_rate_observation", magnitudeUnit: "vnd" },
  // trade
  tariff_rate: { action: "tariff_change", magnitudeUnit: "percent" },
  tariff: { action: "tariff_change", magnitudeUnit: "percent" },
  tariff_reduction: { action: "tariff_change", direction: "decrease" },
  tariff_reduction_value: {
    action: "tariff_change",
    direction: "decrease",
  },
  reciprocal_tariff: { action: "tariff_change", magnitudeUnit: "percent" },
  trade_agreement: { action: "trade_agreement" },
  trade_agreement_extension: { action: "trade_agreement" },
  trade_deal: { action: "trade_agreement" },
  /* signed_agreement stays unmapped — the corpus shows it covers security
   * pacts (Greenland) as often as trade deals; guessing is worse than
   * abstaining. */
  // sanctions / export controls
  sanctions: { action: "sanction_change", direction: "impose" },
  sanction: { action: "sanction_change", direction: "impose" },
  impose_sanctions: { action: "sanction_change", direction: "impose" },
  lift_sanctions: { action: "sanction_change", direction: "remove" },
  sanctions_lifted: { action: "sanction_change", direction: "remove" },
  export_ban: { action: "export_regulation_change", direction: "impose" },
  export_control: { action: "export_regulation_change", direction: "impose" },
  export_regulation: { action: "export_regulation_change" },
  import_ban: { action: "export_regulation_change", direction: "impose" },
  // fiscal
  fiscal_spending: { action: "fiscal_spending" },
  government_spending: { action: "fiscal_spending" },
  stimulus: { action: "fiscal_spending" },
  fund_disbursement: { action: "fund_disbursement" },
  aid_disbursement: { action: "fund_disbursement" },
  military_aid: { action: "fund_disbursement" },
  military_aid_disbursement: { action: "fund_disbursement" },
  disbursement: { action: "fund_disbursement" },
  debt: { action: "debt_change" },
  debt_to_gdp: { action: "debt_change", magnitudeUnit: "percent" },
  national_debt: { action: "debt_change" },
  sovereign_default: { action: "credit_liquidity_shock" },
  default: { action: "credit_liquidity_shock" },
  bank_run: { action: "credit_liquidity_shock" },
  bank_failure: { action: "banking_stress" },
  bank_rescue: { action: "banking_stress" },
  bailout: { action: "banking_stress" },
  credit_freeze: { action: "credit_liquidity_shock" },
  interbank_freeze: { action: "credit_liquidity_shock" },
  liquidity_facility: { action: "credit_liquidity_shock" },
  emergency_lending: { action: "credit_liquidity_shock" },
  banking_stress: { action: "banking_stress" },
  bank_recapitalization: { action: "banking_stress" },
  // corporate
  investment: { action: "investment_commitment" },
  investment_commitment: { action: "investment_commitment" },
  foreign_investment: { action: "investment_commitment" },
  mo_rong_dau_tu: { action: "investment_commitment" },
  net_profit: { action: "corporate_profit_change" },
  profit: { action: "corporate_profit_change" },
  revenue: { action: "corporate_profit_change" },
  dividend: { action: "corporate_action" },
  stock_split: { action: "corporate_action" },
  buyback: { action: "corporate_action" },
  // indicators
  growth_pct: { action: "economic_indicator_change", magnitudeUnit: "percent" },
  gdp_growth: { action: "economic_indicator_change", magnitudeUnit: "percent" },
  inflation_rate: {
    action: "economic_indicator_change",
    magnitudeUnit: "percent",
  },
  unemployment_rate: {
    action: "economic_indicator_change",
    magnitudeUnit: "percent",
  },
  cpi: { action: "economic_indicator_change" },
  /* an observed price/price-change of a traded asset IS an economic
   * indicator observation — it is not an agent action, but it is not
   * "unknown" either */
  price: { action: "economic_indicator_change" },
  price_change: { action: "economic_indicator_change" },
  oil_price: { action: "economic_indicator_change" },
  stock_index: { action: "economic_indicator_change" },
  jobs_created: { action: "economic_indicator_change" },
  signed_ftas: { action: "economic_indicator_change" },
  qr_payment_growth: { action: "economic_indicator_change" },
  import_increase: { action: "economic_indicator_change" },
  import_value: { action: "economic_indicator_change" },
  export_value: { action: "economic_indicator_change" },
  commodity_purchase: { action: "economic_indicator_change" },
  recovery_plan_budget: { action: "fiscal_spending" },
  federal_budget_cancellation: { action: "fiscal_spending" },
  budget_cancellation: { action: "fiscal_spending" },
  de_xuat_huy_ngan_sach: { action: "fiscal_spending" },
  them_cong_ty_vao_danh_sach_den: {
    action: "sanction_change",
    direction: "impose",
  },
  money_usd: { action: "unknown_economic_action", magnitudeUnit: "usd" },
  money_vnd: { action: "unknown_economic_action", magnitudeUnit: "vnd" },
  damage_usd: { action: "unknown_economic_action", magnitudeUnit: "usd" },
};

/* Predicates that are clearly non-economic — scores, casualties, ceremony.
 * Everything not in either list → unknown_economic_action (honest). */
const NON_ECONOMIC = new Set([
  "deaths",
  "injured",
  "casualties",
  "match_score",
  "medal",
  "gold_medals",
  "medal_won",
  "tournament_stage",
  "speech_location",
  "speech_date",
  "visit",
  "state_visit",
  "visit_end_date",
  "visit_duration",
  "departure_date",
  "return_date",
  "event_date",
  "event_attendance",
  "meeting_location",
  "diplomatic_meeting",
  "invitation",
  "gift",
  "evacuated",
  "dismissal",
  "tuyen_bo",
  "de_xuat",
  "ket_thuc_chuyen_tham",
  "negotiation_stance",
  "maintain_position",
  "ai_communication_channel",
  "ceasefire_proposal",
  "rejected_proposal",
  "consensus_points",
  "action",
  "missile",
  "uav",
  "ceasefire",
  "strike",
]);

/* ── subject resolution ─────────────────────────────────────── */

/* \b is ASCII-only in JS — it never fires around "ỹ", "ộ", "ă"…, which is
 * why "Bộ Tài Chính Mỹ" used to resolve to nothing (and "Mỹ và Trung
 * Quốc" silently skipped the US). Use Unicode letter boundaries instead. */
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const jx = (s: TemplateStringsArray) => new RegExp(`${L}(?:${s[0]})${R}`, "iu");

/** Country-code hints for qualifierText that never resolved to an entity.
 * Not a fake entity — only used to set affectedJurisdiction for scope. */
const SUBJECT_JURISDICTIONS: [RegExp, string][] = [
  [jx`federal reserve|fed|fomc`, "US"],
  [jx`ecb|european central bank`, "EU"],
  [jx`nhnn|ngân hàng nhà nước|sbv|state bank of vietnam`, "VN"],
  [jx`pboc|people's bank of china`, "CN"],
  [jx`boj|bank of japan`, "JP"],
  [jx`boe|bank of england`, "GB"],
  [
    jx`united states|u\.?s\.?|mỹ|hoa kỳ|washington|nhà trắng|white house|bộ tài chính mỹ|us treasury`,
    "US",
  ],
  [jx`trung quốc|china|beijing|bắc kinh`, "CN"],
  [jx`việt nam|vietnam|hà nội|hanoi`, "VN"],
  [jx`nga|russia|moscow|matxcơva|kremlin|điện kremlin`, "RU"],
  [jx`ukraine|ukraina|kyiv|kiev`, "UA"],
  [jx`iran|tehran`, "IR"],
  [jx`eu|european union|châu âu|brussels`, "EU"],
  [jx`nhật|japan|tokyo`, "JP"],
  [jx`hàn quốc|south korea|korea|seoul`, "KR"],
  [jx`ấn độ|india|new delhi`, "IN"],
  [jx`taiwan|đài loan`, "TW"],
];

const GLOBAL_JURISDICTIONS = new Set(["US", "EU", "CN", "JP", "GB"]);

/** Central-bank / monetary-authority patterns. A generic `interest_rate`
 * claim is only a monetary_policy_change when the subject is a proven
 * policy authority AND a previous decision value exists — exactly the
 * R7.0 lesson: an effective rate observation is not a policy decision. */
const POLICY_AUTHORITIES = [
  jx`federal reserve|fed|fomc`,
  jx`ecb|european central bank`,
  jx`nhnn|ngân hàng nhà nước|sbv|state bank of vietnam`,
  jx`pboc|people's bank of china`,
  jx`boj|bank of japan`,
  jx`boe|bank of england`,
  jx`ngân hàng trung ương|central bank`,
];

function isPolicyAuthority(
  qualifierText: string | null,
  canonicalKey: string | null,
  entityType: string | null,
): boolean {
  if (entityType === "central_bank" || entityType === "monetary_authority")
    return true;
  const blob = `${qualifierText ?? ""} ${canonicalKey ?? ""}`;
  return POLICY_AUTHORITIES.some((re) => re.test(blob));
}

export interface ResolvedSubject {
  entityId: string | null;
  canonicalKey: string | null;
  type: string | null;
  jurisdiction: string | null; // first matched — primary affected country
  /** every jurisdiction named in the subject ("Mỹ và Trung Quốc" → US+CN) */
  jurisdictions: string[];
  /** subject is a central bank / monetary authority */
  policyAuthority: boolean;
  caution: "subject_unresolved" | "subject_text_only" | null;
}

export function resolveSubject(i: ClaimMaterialityInput): ResolvedSubject {
  const policyAuthority = isPolicyAuthority(
    i.subject.qualifierText ?? null,
    i.subject.canonicalKey ?? null,
    i.subject.type ?? null,
  );
  if (i.subject.entityId) {
    const j = i.subject.countryCode ?? null;
    return {
      entityId: i.subject.entityId,
      canonicalKey: i.subject.canonicalKey ?? null,
      type: i.subject.type ?? null,
      jurisdiction: j,
      jurisdictions: j ? [j] : [],
      policyAuthority,
      caution: null,
    };
  }
  /* qualifier text is the primary subject hint, but prod rows often carry
   * only a canonicalKey display name ("Bộ Tài Chính Mỹ") — scan both */
  const text = i.subject.qualifierText ?? i.subject.canonicalKey;
  if (text) {
    /* text-fallback still preserves the declared entity type — a company
     * named only in qualifier text is still an issuer-scoped subject */
    const declaredType = i.subject.type ?? null;
    const hits = SUBJECT_JURISDICTIONS.filter(([re]) => re.test(text)).map(
      ([, code]) => code,
    );
    return {
      entityId: null,
      canonicalKey: null,
      type: declaredType,
      jurisdiction: hits[0] ?? null,
      jurisdictions: [...new Set(hits)],
      policyAuthority,
      caution: "subject_text_only",
    };
  }
  return {
    entityId: null,
    canonicalKey: null,
    type: null,
    jurisdiction: null,
    jurisdictions: [],
    policyAuthority,
    caution: "subject_unresolved",
  };
}

/* ── magnitude extraction ───────────────────────────────────── */

function numericValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  // "2.300 tỷ" — dots ending in exactly-3-digit groups are VN thousands
  // separators; "6,6" / "1.50" are decimals. Decide before stripping.
  // leading group "0" excluded — "0.001" is a decimal, not "0,001" thousand
  if (/^-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Pure currency rates — magnitude (tỷ/triệu/ty_/bn) is applied earlier.
 * Ordered: VNĐ/EUR/CNY/JPY/GBP before plain "$" (USD). */
const USD_APPROX: [RegExp | string, number][] = [
  // [a-z_]* prefix tolerates normalized unit spellings like "ty_vnd",
  // where \b never fires after the underscore. (?=_bn|\b) lets the
  // currency match inside magnitude units like "usd_bn" — the _bn part
  // is handled by the magnitude step, not doubled here.
  [/[a-z_]*vnđ(?=_bn\b|\b)|[a-z_]*vnd(?=_bn\b|\b)|đồng/i, 1 / 25000],
  [/[a-z_]*euro(?=_bn\b|\b)|[a-z_]*eur(?=_bn\b|\b)|€/i, 1.08],
  [/[a-z_]*yuan(?=_bn\b|\b)|[a-z_]*cny(?=_bn\b|\b)|nhân dân tệ/i, 0.14],
  [/[a-z_]*jpy(?=_bn\b|\b)|yên/i, 0.0067],
  [/[a-z_]*gbp(?=_bn\b|\b)|£/, 1.27],
  [/[a-z_]*usd(?=_bn\b|\b)|[a-z_]*us\$|\$|đô la/i, 1],
];

/** Parse "6,6 tỉ euro" / "$2.65" / "2.300 tỷ đồng" into approximate USD.
 * Returns null when the text carries no parseable magnitude. */
export function approxUsd(value: unknown, unit: string | null): number | null {
  const text = typeof value === "string" ? value : null;
  let n = numericValue(value);
  if (n === null) return null;
  // Vietnamese magnitude words inside the text or unit
  const blob = `${text ?? ""} ${unit ?? ""}`.toLowerCase();
  // \b fails around non-ASCII vowels (tỷ, triệu) — use lookahead instead.
  // "tỉ" needs a non-letter lookahead so it never fires inside "tỉnh".
  // ty_/trieu_ cover normalized unit spellings from the extractor
  // ("ty_usd" = tỷ USD — the unit already carries the scale).
  if (
    /(tỷ|tỉ|nghìn tỷ)(?=[^a-zà-ỹ]|$)|\bty_|\b[a-z0-9_]+_bn\b|\bbillion\b|\bbn\b/i.test(
      blob,
    )
  )
    n *= 1e9;
  else if (
    /(triệu)(?=[^a-zà-ỹ]|$)|\btrieu_|\b[a-z0-9_]+_mn\b|\bmillion\b|\bmn\b/i.test(
      blob,
    )
  )
    n *= 1e6;
  else if (/(nghìn)(?=[^a-zà-ỹ]|$)|\bthousand\b/i.test(blob)) n *= 1e3;
  for (const [cur, rate] of USD_APPROX) {
    if (typeof cur === "string" ? blob.includes(cur) : cur.test(blob))
      return n * rate;
  }
  /* No currency marker → NULL, not an implicit USD assumption.
   * "500" with unit=null is not $500 — unknown currency must surface as
   * currency_unverified, not a silent magnitude upgrade. */
  return null;
}

/* ── action inference ───────────────────────────────────────── */

export function inferClaimAction(i: ClaimMaterialityInput): EconomicAction {
  const subj = resolveSubject(i);
  const base: Omit<
    EconomicAction,
    "type" | "magnitude" | "magnitudeUnit" | "direction" | "confidence"
  > = {
    actor: i.subject.qualifierText ?? i.subject.canonicalKey ?? null,
    affectedJurisdiction: subj.jurisdiction,
    sourceClaimVersionId: i.current.versionId,
  };
  const spec = PREDICATE_ACTIONS[i.predicate];
  if (!spec) {
    return {
      ...base,
      type: NON_ECONOMIC.has(i.predicate)
        ? "non_economic"
        : "unknown_economic_action",
      magnitude: null,
      magnitudeUnit: null,
      direction: null,
      confidence: "low",
    };
  }

  const cur = numericValue(i.current.value);
  const prev = i.previous ? numericValue(i.previous.value) : null;
  let magnitude = cur;
  let direction = spec.direction ?? null;
  if (cur !== null && prev !== null) {
    const delta = cur - prev;
    magnitude = Math.abs(delta);
    if (delta > 0) direction = "increase";
    else if (delta < 0) direction = "decrease";
    else direction = "unchanged";
  }

  let type = spec.action;
  /* A generic `interest_rate` is only a policy decision when a policy
   * authority AND a previous decision value both exist. Same invariant
   * as the macro engine: effective-rate observations are observations. */
  if (type === "monetary_policy_change") {
    const policyNamed = /^(policy_rate|base_rate|refinancing_rate)$/.test(
      i.predicate,
    );
    const hasDelta = i.previous != null && prev !== null;
    if (!hasDelta || !(policyNamed || subj.policyAuthority))
      type = "interest_rate_observation";
  }

  return {
    ...base,
    type,
    magnitude,
    magnitudeUnit: spec.magnitudeUnit ?? i.current.unit ?? null,
    direction,
    confidence: cur !== null ? "medium" : "low", // text-only values stay low-confidence magnitude
  };
}

/* ── claim materiality scoring ──────────────────────────────── */

export interface ClaimMaterialityAssessment extends MaterialityAssessment {
  action: EconomicAction;
  evidenceState: ClaimState;
  /** claims excluded from event contribution entirely */
  excluded: boolean;
  reasonCodes: string[];
  claimId: string;
  claimVersionId: string;
  method: string;
  methodVersion: string;
}

const METHOD = "deterministic-claim";
const METHOD_VERSION = "r7.1b.1";

function assess(
  i: ClaimMaterialityInput,
  action: EconomicAction,
  subj: ResolvedSubject,
): ClaimMaterialityAssessment {
  const cautions: string[] = [];
  const reasonCodes: string[] = [];
  if (subj.caution) cautions.push(subj.caution);
  const state = i.evidence.claimState;

  // truth-state gates — R6 owns the state, we only honor it
  if (state === "retracted") {
    return {
      materiality: "none",
      scope: null,
      channels: [],
      directness: null,
      persistence: null,
      horizon: null,
      affectedTargets: [],
      transmissionConfidence: null,
      reason: "retracted claim — no live contribution",
      cautions,
      action,
      evidenceState: state,
      excluded: true,
      reasonCodes: ["retracted"],
      claimId: i.claimId,
      claimVersionId: i.current.versionId,
      method: METHOD,
      methodVersion: METHOD_VERSION,
    };
  }
  let transCap: "low" | "medium" | "high" = "high";
  if (state === "disputed") {
    transCap = "low";
    cautions.push("disputed");
  } else if (state === "corrected") {
    cautions.push("corrected_claim");
  } else if (state === "reported") {
    transCap = "medium";
    cautions.push("single_report");
  } else if (state === "unresolved") {
    transCap = "low";
    cautions.push("unresolved_claim");
  }
  if (i.evidence.confirmedIndependentOrigins <= 1)
    cautions.push("single_origin");

  const empty = (
    m: MaterialityLevel | "unknown",
    reason: string,
    codes: string[],
  ) =>
    ({
      materiality: m,
      scope: null,
      channels: [],
      directness: null,
      persistence: null,
      horizon: null,
      affectedTargets: [],
      transmissionConfidence: null,
      reason,
      cautions,
      action,
      evidenceState: state,
      excluded: false,
      reasonCodes: codes,
      claimId: i.claimId,
      claimVersionId: i.current.versionId,
      method: METHOD,
      methodVersion: METHOD_VERSION,
    }) satisfies ClaimMaterialityAssessment;

  if (action.type === "non_economic")
    return empty("none", "non-economic claim", ["non_economic"]);
  if (action.type === "unknown_economic_action")
    return empty("unknown", "economic action unresolved — abstain", [
      "unclassified",
    ]);

  const jurisdiction = action.affectedJurisdiction;
  const jurisdictions = subj.jurisdictions.length
    ? subj.jurisdictions
    : jurisdiction
      ? [jurisdiction]
      : [];
  const globalScope = jurisdictions.some((j) => GLOBAL_JURISDICTIONS.has(j));
  const scope: Scope = globalScope
    ? "global_systemic"
    : jurisdictions.includes("VN")
      ? "vietnam"
      : subj.type === "company" || subj.entityId != null
        ? "issuer"
        : "sector";

  const targets: Target[] = [];
  for (const j of jurisdictions)
    targets.push({ type: "country_exposure", key: j.toLowerCase() });
  if (subj.entityId && subj.type !== "country")
    targets.push({ type: "entity", key: subj.canonicalKey ?? subj.entityId });

  let level: MaterialityLevel = "limited";
  let channels: Channel[] = [];
  let directness: Directness = "first_order";
  let persistence: Persistence = "cyclical";
  let horizon: Horizon = "weeks";
  let transConf: "low" | "medium" | "high" = "medium";
  // truth-state ceiling: disputed/unresolved claims keep their intrinsic
  // magnitude but their transmission confidence is capped.
  const mag = action.magnitude;

  switch (action.type) {
    case "monetary_policy_change": {
      channels = ["discounting", "funding_liquidity"];
      directness = "direct";
      horizon = "months";
      // magnitude = |Δpp| when a previous version exists, else level move —
      // an unchanged rate observation is not a policy step.
      const step = i.previous ? mag : null;
      if (step === null) {
        level = "limited";
        reasonCodes.push("rate_level_no_delta");
        cautions.push("no_prior_observation");
      } else if (step >= 1.0) {
        level = globalScope ? "systemic" : "major";
        reasonCodes.push("policy_step_shock");
      } else if (step >= 0.5) {
        level = globalScope ? "major" : "meaningful";
        reasonCodes.push("policy_step_large");
      } else if (step >= 0.1) {
        /* a home-market (VN) central-bank decision is meaningful to this
         * radar even though it is not globally systemic */
        level =
          globalScope || jurisdictions.includes("VN")
            ? "meaningful"
            : "limited";
        reasonCodes.push("policy_step");
      } else {
        level = "limited";
        reasonCodes.push("policy_step_small");
      }
      break;
    }
    case "interest_rate_observation":
      channels = ["discounting"];
      directness = "second_order";
      level = "limited";
      reasonCodes.push("rate_observation_only");
      break;
    case "tariff_change": {
      channels = ["policy_regulatory", "external"];
      directness = "first_order";
      persistence = "structural";
      horizon = "months";
      // Rate claims (%) and dollar-denominated tariff-value claims are
      // different magnitudes — never run a USD number through the pp ladder.
      const isPct =
        action.magnitudeUnit === "percent" ||
        i.current.unit === "%" ||
        /%/.test(String(i.current.value ?? ""));
      if (!isPct) {
        const usd = approxUsd(i.current.value, i.current.unit);
        if (usd !== null && usd >= 50e9 && globalScope) {
          level = "major";
          reasonCodes.push("tariff_flow_macro_scale");
        } else if (usd !== null && usd >= 10e9) {
          level = globalScope ? "meaningful" : "limited";
          reasonCodes.push("tariff_flow_large");
        } else if (usd !== null) {
          level = "limited";
          reasonCodes.push("tariff_flow_small");
        } else {
          level = "limited";
          if (numericValue(i.current.value) !== null) {
            reasonCodes.push("amount_currency_unverified");
            cautions.push("currency_unverified");
          } else {
            reasonCodes.push("tariff_unsized");
            cautions.push("magnitude_text_only");
          }
        }
        break;
      }
      const pct = mag;
      if (pct !== null && pct >= 25 && globalScope) {
        level = "systemic";
        reasonCodes.push("tariff_regime_shift");
      } else if (pct !== null && pct >= 20) {
        level = "major";
        reasonCodes.push("tariff_large");
      } else if (pct !== null && pct >= 5) {
        level = "meaningful";
        reasonCodes.push("tariff_material");
      } else {
        level = "limited";
        reasonCodes.push("tariff_minor_or_unsized");
      }
      if (!globalScope && jurisdictions.includes("VN"))
        level = cap(level, "major");
      break;
    }
    case "trade_agreement": {
      channels = ["policy_regulatory", "external"];
      persistence = "structural";
      horizon = "months";
      /* a bilateral trade lane touching the home market is meaningful —
       * VN-EU/VN-US style deals move the product's core exposures */
      level =
        globalScope || jurisdictions.includes("VN") ? "meaningful" : "limited";
      if (globalScope) reasonCodes.push("trade_deal_global");
      else if (jurisdictions.includes("VN")) reasonCodes.push("trade_deal_vn");
      else reasonCodes.push("trade_deal");
      break;
    }
    case "sanction_change":
    case "export_regulation_change": {
      channels = ["policy_regulatory", "external"];
      persistence = "structural";
      /* narrow targeted measures (individuals, named officials, single
       * technical-service restrictions) stay limited even when the
       * sanctioning power is global — "hạn chế" is a restricted measure,
       * not a comprehensive regime */
      const narrow =
        action.type === "sanction_change" &&
        /(cá nhân|quan chức|individual|officials?|doanh nhân|hạn chế|chứng chỉ|certificate|targeted)/i.test(
          String(i.current.value ?? ""),
        );
      /* sanctions touching commodity/systemic-scale jurisdictions are
       * meaningful even though the target itself is not "global" */
      const majorTarget = jurisdictions.some((j) =>
        ["US", "EU", "CN", "RU", "IR", "JP", "GB"].includes(j),
      );
      if (narrow) {
        level = "limited";
        reasonCodes.push("sanction_narrow");
      } else if (action.type === "export_regulation_change" && globalScope) {
        level = "major"; // e.g. chip export controls — direct supply channel
        reasonCodes.push("export_control_global");
      } else if (globalScope || majorTarget) {
        level = "meaningful";
        reasonCodes.push("sanction_global");
      } else {
        level = "limited";
        reasonCodes.push("sanction_local");
      }
      break;
    }
    case "fiscal_spending":
    case "fund_disbursement": {
      channels = ["fundamental", "funding_liquidity"];
      horizon = "months";
      const usd = approxUsd(i.current.value, i.current.unit);
      if (usd === null) {
        level = "limited";
        if (numericValue(i.current.value) !== null) {
          reasonCodes.push("amount_currency_unverified");
          cautions.push("currency_unverified");
        } else {
          reasonCodes.push("amount_unparsed");
          cautions.push("magnitude_text_only");
        }
      } else if (usd >= 50e9 && globalScope) {
        level = "major";
        reasonCodes.push("spending_macro_scale");
      } else if (usd >= 5e9) {
        /* a ≥$5B flow is meaningful on its own — €6.6B of reconstruction
         * aid matters even when the funding subject didn't resolve */
        level = "meaningful";
        reasonCodes.push("spending_large");
      } else {
        level = "limited";
        reasonCodes.push("spending_small");
      }
      break;
    }
    case "debt_change": {
      channels = ["funding_liquidity"];
      horizon = "long_term";
      persistence = "structural";
      level = "limited";
      reasonCodes.push("debt_observation");
      break;
    }
    case "investment_commitment": {
      channels = ["fundamental"];
      directness = "second_order";
      horizon = "long_term";
      const usd = approxUsd(i.current.value, i.current.unit);
      if (usd !== null && usd >= 1e9) {
        level = "meaningful";
        reasonCodes.push("capex_macro_scale");
      } else {
        level = "limited";
        reasonCodes.push("capex_commitment");
        if (usd === null && numericValue(i.current.value) !== null)
          cautions.push("currency_unverified");
      }
      break;
    }
    case "corporate_profit_change": {
      channels = ["fundamental"];
      const hasDelta = i.previous != null;
      const scoped = subj.type === "company" || subj.entityId != null;
      if (hasDelta && scoped) {
        level = "meaningful";
        reasonCodes.push("earnings_delta");
      } else {
        level = "limited";
        reasonCodes.push(scoped ? "earnings_level" : "earnings_unscoped");
      }
      break;
    }
    case "corporate_action":
      channels = ["fundamental"];
      level = "limited";
      reasonCodes.push("corporate_action_claim");
      break;
    case "credit_liquidity_shock": {
      channels = ["funding_liquidity", "discounting"];
      directness = "direct";
      persistence = "structural";
      horizon = "immediate";
      transConf = "high";
      /* Sovereign default / credit freeze / emergency facility — a
       * global-jurisdiction shock is systemic; a local one is major. */
      const crisisVerb =
        /^(sovereign_default|default|bank_run|credit_freeze|interbank_freeze)$/.test(
          i.predicate,
        );
      if (globalScope && crisisVerb) {
        level = "systemic";
        reasonCodes.push("systemic_credit_shock");
      } else if (globalScope || crisisVerb) {
        level = "major";
        reasonCodes.push("credit_shock");
      } else {
        level = "meaningful";
        reasonCodes.push("credit_stress");
      }
      break;
    }
    case "banking_stress": {
      channels = ["funding_liquidity"];
      directness = "first_order";
      horizon = "weeks";
      level = globalScope ? "major" : "meaningful";
      reasonCodes.push(globalScope ? "bank_stress_global" : "bank_stress");
      break;
    }
    case "economic_indicator_change": {
      channels = ["fundamental"];
      /* the magnitude ladder is percentage semantics — "20 triệu tấn" is
       * a volume, not a 20pp move, and must not take the pct path */
      const isPct =
        action.magnitudeUnit === "percent" ||
        /%|percent|phần trăm/i.test(
          `${i.current.unit ?? ""} ${i.current.value ?? ""}`,
        );
      const pct = isPct ? mag : null;
      if (pct !== null && pct >= 2 && globalScope) {
        level = "meaningful";
        reasonCodes.push("indicator_large_global");
      } else if (pct !== null && pct >= 1) {
        level = "limited";
        reasonCodes.push("indicator_notable");
      } else {
        level = "limited";
        reasonCodes.push("indicator_minor");
      }
      break;
    }
  }

  if (level === "limited" && reasonCodes.length === 0)
    reasonCodes.push("default_limited");

  return {
    materiality: level,
    scope,
    channels,
    directness,
    persistence,
    horizon,
    affectedTargets: targets,
    transmissionConfidence: (["low", "medium", "high"] as const)[
      Math.min(
        (["low", "medium", "high"] as const).indexOf(transConf),
        (["low", "medium", "high"] as const).indexOf(transCap),
      )
    ],
    reason: reasonCodes.join(","),
    cautions,
    action,
    evidenceState: state,
    excluded: false,
    reasonCodes,
    claimId: i.claimId,
    claimVersionId: i.current.versionId,
    method: METHOD,
    methodVersion: METHOD_VERSION,
  };
}

export function scoreClaimMateriality(
  i: ClaimMaterialityInput,
): ClaimMaterialityAssessment {
  const subj = resolveSubject(i);
  const action = inferClaimAction(i);
  return assess(i, action, subj);
}

/* ── claim → event aggregation ──────────────────────────────── */

export interface EventClaimAggregation {
  materiality: MaterialityLevel | "unknown";
  scope: Scope | null;
  channels: Channel[];
  affectedTargets: Target[];
  /** claims that produced the winning level — the UI's "why is this major?" */
  driverClaimIds: string[];
  contributingClaimIds: string[];
  confidence: "low" | "medium" | "high" | null;
  cautions: string[];
  method: string;
  methodVersion: string;
}

/** event materiality = max credible material claim. Not an average —
 * 60 trivia claims + 1 major policy claim ⇒ major event. */
export function aggregateClaimsToEvent(
  claims: ClaimMaterialityAssessment[],
): EventClaimAggregation {
  const live = claims.filter(
    (c) =>
      !c.excluded && c.materiality !== "none" && c.materiality !== "unknown",
  );
  if (live.length === 0) {
    const anyUnknown = claims.some((c) => c.materiality === "unknown");
    return {
      materiality: anyUnknown ? "unknown" : "none",
      scope: null,
      channels: [],
      affectedTargets: [],
      driverClaimIds: [],
      contributingClaimIds: [],
      confidence: null,
      cautions: [],
      method: METHOD,
      methodVersion: METHOD_VERSION,
    };
  }
  const maxRank = Math.max(
    ...live.map((c) => LEVEL_RANK.indexOf(c.materiality as MaterialityLevel)),
  );
  const drivers = live.filter(
    (c) => LEVEL_RANK.indexOf(c.materiality as MaterialityLevel) === maxRank,
  );
  const contributors = live.filter(
    (c) =>
      LEVEL_RANK.indexOf(c.materiality as MaterialityLevel) >=
      LEVEL_RANK.indexOf("meaningful"),
  );
  const channels = [...new Set(contributors.flatMap((c) => c.channels))];
  const targets = dedupeTargets(contributors.flatMap((c) => c.affectedTargets));
  const cautions = [...new Set(drivers.flatMap((c) => c.cautions))];
  // event confidence = worst cap among drivers: a major carried only by
  // disputed/reported claims stays publishable but visibly cautioned.
  const confOrder = ["low", "medium", "high"] as const;
  const confidence = drivers.reduce<(typeof confOrder)[number] | null>(
    (acc, c) => {
      const t = c.transmissionConfidence;
      if (t === null) return acc;
      if (acc === null) return t;
      return confOrder.indexOf(t) < confOrder.indexOf(acc) ? t : acc;
    },
    null,
  );
  return {
    materiality: LEVEL_RANK[maxRank],
    scope: drivers[0].scope,
    channels,
    affectedTargets: targets,
    driverClaimIds: drivers.map((c) => c.claimId),
    contributingClaimIds: contributors.map((c) => c.claimId),
    confidence,
    cautions,
    method: METHOD,
    methodVersion: METHOD_VERSION,
  };
}

function dedupeTargets(t: Target[]): Target[] {
  const seen = new Set<string>();
  return t.filter((x) => {
    const k = `${x.type}:${x.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
