/* Corporate Actions — pure derivation layer.
 *
 * Identity law: an action attaches to financial_instruments.id — never to
 * a ticker and never to a market series. Canonical identity =
 * (instrument_id, action_type, ex_date); amount/ratio/dates are SEMANTIC
 * fields — providers may correct them, they never redefine identity.
 *
 * Assertions are provider truth, never canonical truth. The canonical
 * version's fields come from ONE source by documented precedence —
 * dedicated CA endpoints outrank EOD-derived columns — with every other
 * attached assertion linked via derivations (corroborates / conflicts),
 * so disagreement is structurally visible, never averaged away.
 *
 * Precedence (higher = more authoritative for canonical fields):
 *   dividends | splits | distributions | tiingo_splits   → dedicated = 2
 *   eod_daily (divCash/splitFactor columns)               → derived  = 1
 */
import { normalizeDecimalString } from "./market";

export type ActionType = "cash_dividend" | "stock_split";

/** Semantic fields an assertion may carry — all optional except the
 *  identity triple. NULL means "provider didn't assert it", never 0. */
export interface CaSemantics {
  exDate: string;
  declarationDate?: string | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  cashAmount?: string | null;
  currency?: string | null;
  splitFrom?: string | null;
  splitTo?: string | null;
  splitFactor?: string | null;
  status?: "active" | "cancelled";
  /** provider's own status word ('completed','cancelled',…) — preserved
   *  verbatim on the assertion; mapped to canonical status at apply */
  providerStatus?: string | null;
}

export interface CaAssertionInput extends CaSemantics {
  instrumentId: string;
  sourceListingId: string | null;
  provider: string;
  dataset: string;
  providerRecordKey: string;
  actionType: ActionType;
  providerStatus?: string | null;
  observationId: string;
}

/** Canonical-decimal fingerprint of the semantic payload — "0.25" and
 *  "0.2500" from two providers are the same assertion; "0.25" vs "0.27"
 *  is a real divergence. */
export function caFingerprint(s: CaSemantics): string {
  const d = (v: string | null | undefined) =>
    v == null ? "" : (normalizeDecimalString(v) ?? `!${v}`);
  const t = (v: string | null | undefined) => v ?? "";
  return [
    s.exDate,
    t(s.declarationDate),
    t(s.recordDate),
    t(s.paymentDate),
    d(s.cashAmount),
    t(s.currency),
    d(s.splitFrom),
    d(s.splitTo),
    d(s.splitFactor),
    t(s.status),
  ].join("|");
}

/** Source rank for canonical authorship — dedicated CA endpoints assert;
 *  EOD columns hint. */
export function caDatasetRank(dataset: string): number {
  return dataset === "eod_daily" ? 1 : 2;
}

const SEMANTIC_CMP: (keyof CaSemantics)[] = [
  "exDate",
  "declarationDate",
  "recordDate",
  "paymentDate",
  "cashAmount",
  "currency",
  "splitFrom",
  "splitTo",
  "splitFactor",
];

/** Fields where BOTH sides assert a value and they disagree — NULL means
 *  "provider didn't assert it" and never counts as divergence. A partial
 *  assertion that agrees on every shared field is corroboration. */
export function caDivergentFields(a: CaSemantics, b: CaSemantics): string[] {
  const out: string[] = [];
  for (const f of SEMANTIC_CMP) {
    const va = a[f];
    const vb = b[f];
    if (va == null || vb == null) continue;
    const na =
      f === "exDate" ||
      f === "declarationDate" ||
      f === "recordDate" ||
      f === "paymentDate" ||
      f === "currency"
        ? String(va)
        : (normalizeDecimalString(String(va)) ?? `!${va}`);
    const nb =
      f === "exDate" ||
      f === "declarationDate" ||
      f === "recordDate" ||
      f === "paymentDate" ||
      f === "currency"
        ? String(vb)
        : (normalizeDecimalString(String(vb)) ?? `!${vb}`);
    if (na !== nb) out.push(f);
  }
  // status divergence counts too — a provider marking cancelled vs another
  // asserting active on the same event is a real semantic disagreement
  if (a.status && b.status && a.status !== b.status) out.push("status");
  return out;
}

/** Provider status string → canonical status. Anything the provider marks
 *  cancelled/deleted maps to 'cancelled'; absent or unknown → 'active'. */
export function caStatus(
  providerStatus: string | null | undefined,
): "active" | "cancelled" {
  const s = (providerStatus ?? "").toLowerCase();
  return /cancel|delet|removed/.test(s) ? "cancelled" : "active";
}

// ── Alpha Vantage DIVIDENDS / SPLITS ─────────────────────────────────────

export type AlphaCaResult =
  | {
      kind: "actions";
      actions: CaSemantics[];
      meta: { symbol?: string };
    }
  | {
      kind: "provider_error";
      errorClass:
        | "rate_limit"
        | "invalid_symbol"
        | "empty"
        | "unexpected_schema"
        | "api_error";
      detail: string;
    };

const alphaError = (p: Record<string, unknown>): AlphaCaResult | null => {
  if (typeof p["Error Message"] === "string")
    return {
      kind: "provider_error",
      errorClass: "invalid_symbol",
      detail: p["Error Message"],
    };
  if (typeof p["Note"] === "string")
    return {
      kind: "provider_error",
      errorClass: "rate_limit",
      detail: p["Note"],
    };
  if (typeof p["Information"] === "string")
    return {
      kind: "provider_error",
      errorClass: "rate_limit",
      detail: p["Information"],
    };
  return null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v: unknown): string | null =>
  typeof v === "string" && DATE.test(v) ? v : null;

/** Alpha DIVIDENDS: {symbol, data:[{ex_dividend_date,declaration_date,
 *  record_date,payment_date,amount}]} — verified against the live
 *  endpoint. Missing dates stay NULL — never inferred. */
export function parseAlphaDividends(payload: unknown): AlphaCaResult {
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;
  const err = alphaError(p);
  if (err) return err;
  if (!Array.isArray(p.data))
    return Object.keys(p).length === 0
      ? { kind: "provider_error", errorClass: "empty", detail: "{}" }
      : {
          kind: "provider_error",
          errorClass: "unexpected_schema",
          detail: `missing data[] — keys: ${Object.keys(p).join(",")}`,
        };
  const actions: CaSemantics[] = [];
  for (const [i, row] of (p.data as Record<string, unknown>[]).entries()) {
    const exDate = dateOrNull(row.ex_dividend_date ?? row.ex_date);
    if (!exDate)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `data[${i}] missing valid ex_dividend_date: ${JSON.stringify(row.ex_dividend_date)}`,
      };
    actions.push({
      exDate,
      declarationDate: dateOrNull(row.declaration_date),
      recordDate: dateOrNull(row.record_date),
      paymentDate: dateOrNull(row.payment_date),
      cashAmount:
        row.amount == null || row.amount === "" ? null : String(row.amount),
      currency: typeof row.currency === "string" ? row.currency : null,
      status: "active",
    });
  }
  return {
    kind: "actions",
    actions,
    meta: { symbol: typeof p.symbol === "string" ? p.symbol : undefined },
  };
}

/** Alpha SPLITS: {symbol, data:[{effective_date, split_factor}]}. The
 *  effective date IS the ex-date; from/to ratio parts are NOT decomposed
 *  unless the provider gives them (it doesn't). */
export function parseAlphaSplits(payload: unknown): AlphaCaResult {
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;
  const err = alphaError(p);
  if (err) return err;
  if (!Array.isArray(p.data))
    return Object.keys(p).length === 0
      ? { kind: "provider_error", errorClass: "empty", detail: "{}" }
      : {
          kind: "provider_error",
          errorClass: "unexpected_schema",
          detail: `missing data[] — keys: ${Object.keys(p).join(",")}`,
        };
  const actions: CaSemantics[] = [];
  for (const [i, row] of (p.data as Record<string, unknown>[]).entries()) {
    const exDate = dateOrNull(row.effective_date);
    const factor =
      row.split_factor == null || row.split_factor === ""
        ? null
        : String(row.split_factor);
    if (!exDate)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `data[${i}] missing valid effective_date: ${JSON.stringify(row.effective_date)}`,
      };
    actions.push({ exDate, splitFactor: factor, status: "active" });
  }
  return {
    kind: "actions",
    actions,
    meta: { symbol: typeof p.symbol === "string" ? p.symbol : undefined },
  };
}

// ── Tiingo rich corporate-actions (entitlement-gated endpoints) ──────────
// /tiingo/corporate-actions/<t>/distributions and /splits return JSON
// arrays. Only reached when the capability probe shows entitlement —
// free-tier tokens get HTTP 403 and the importer records that instead of
// fabricating. Field names follow Tiingo's documented schema; anything
// absent stays NULL, and splitStatus is preserved verbatim (cancellation
// is a provider assertion, never a deletion).

export type TiingoCaResult =
  | { kind: "actions"; actions: CaSemantics[] }
  | {
      kind: "provider_error";
      errorClass:
        | "rate_limit"
        | "invalid_symbol"
        | "empty"
        | "unexpected_schema"
        | "unauthorized"
        | "entitlement_required"
        | "api_error";
      detail: string;
    };

export function parseTiingoDistributions(payload: unknown): TiingoCaResult {
  if (!Array.isArray(payload))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `expected array, got ${payload == null ? String(payload) : typeof payload}`,
    };
  const actions: CaSemantics[] = [];
  for (const [i, row] of (payload as Record<string, unknown>[]).entries()) {
    const exDate = dateOrNull(row.exDate ?? row.ex_date);
    if (!exDate)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `row ${i} missing valid exDate: ${JSON.stringify(row.exDate)}`,
      };
    const amount =
      row.distribution == null || row.distribution === ""
        ? null
        : String(row.distribution);
    actions.push({
      exDate,
      declarationDate: dateOrNull(row.declarationDate ?? row.declaration_date),
      recordDate: dateOrNull(row.recordDate ?? row.record_date),
      paymentDate: dateOrNull(row.paymentDate ?? row.payment_date),
      cashAmount: amount,
      currency:
        typeof row.currency === "string"
          ? row.currency
          : typeof row.distributionCurrency === "string"
            ? row.distributionCurrency
            : null,
      // provider's own status word is carried through providerStatus →
      // caStatus at apply time (a 'cancelled' stays a versioned transition)
      status: "active",
      providerStatus:
        typeof row.distributionStatus === "string"
          ? row.distributionStatus
          : null,
    });
  }
  return { kind: "actions", actions };
}

export function parseTiingoSplits(payload: unknown): TiingoCaResult {
  if (!Array.isArray(payload))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `expected array, got ${payload == null ? String(payload) : typeof payload}`,
    };
  const actions: CaSemantics[] = [];
  for (const [i, row] of (payload as Record<string, unknown>[]).entries()) {
    const exDate = dateOrNull(row.exDate ?? row.ex_date);
    if (!exDate)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `row ${i} missing valid exDate: ${JSON.stringify(row.exDate)}`,
      };
    const num = (v: unknown) => (v == null || v === "" ? null : String(v));
    actions.push({
      exDate,
      splitFrom: num(row.splitFrom ?? row.split_from),
      splitTo: num(row.splitTo ?? row.split_to),
      splitFactor: num(row.splitFactor ?? row.split_factor),
      status: "active",
      providerStatus:
        typeof row.splitStatus === "string" ? row.splitStatus : null,
    });
  }
  return { kind: "actions", actions };
}

/** Tiingo EOD divCash/splitFactor hint → assertion semantics. divCash≠0 →
 *  cash_dividend; splitFactor≠1 → stock_split. EOD gives no
 *  declaration/record/payment dates — they stay NULL (Phase 8 contract:
 *  never invented). */
export function tiingoHintToSemantics(hint: {
  exDate: string;
  divCash: string;
  splitFactor: string;
}): { type: ActionType; s: CaSemantics }[] {
  const out: { type: ActionType; s: CaSemantics }[] = [];
  const div = normalizeDecimalString(hint.divCash);
  const split = normalizeDecimalString(hint.splitFactor);
  if (div != null && div !== "0")
    out.push({
      type: "cash_dividend",
      s: { exDate: hint.exDate, cashAmount: hint.divCash, status: "active" },
    });
  if (split != null && split !== "1")
    out.push({
      type: "stock_split",
      s: {
        exDate: hint.exDate,
        splitFactor: hint.splitFactor,
        status: "active",
      },
    });
  return out;
}
