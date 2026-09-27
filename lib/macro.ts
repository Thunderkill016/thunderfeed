/* Macro Data — pure layer. FRED response parsing + validation.
 *
 * Evidence model: provider payload lands in reference_observations first
 * (verbatim); this module only interprets it. Values are exact decimal
 * strings — never Number() — because numeric columns must not lose
 * precision through float64.
 *
 * Vintage semantics: FRED returns realtime_start/realtime_end per row —
 * the period when that value was the current official number. A revision
 * produces the same obs_date with a later realtime_start; the apply layer
 * turns that into a new version (append-only), never an UPDATE.
 */
import { normalizeDecimalString } from "./market";

export type FredClass =
  | "ok"
  | "unauthorized" // bad/missing api key (400 with error_code on key, or HTTP 403)
  | "invalid_series"
  | "rate_limited"
  | "empty"
  | "unexpected_schema"
  | "api_error";

/** FRED error payloads: {error_code, error_message}; success is the
 *  endpoint-specific document. HTTP status alone is ambiguous — classify
 *  on the message class too. */
export function classifyFredResponse(
  status: number,
  payload: unknown,
): FredClass {
  const p = payload as Record<string, unknown> | null;
  // error_code arrives as a string on some endpoints, a number on others
  if (
    p &&
    (typeof p.error_code === "string" || typeof p.error_code === "number")
  ) {
    const msg = String(p.error_message ?? "").toLowerCase();
    const code = String(p.error_code).toUpperCase();
    if (
      code === "BAD_REQUEST" &&
      /api.?key|apikey|not authorized|invalid api/.test(msg)
    )
      return "unauthorized";
    if (/api.?key|forbidden/.test(msg) || status === 401 || status === 403)
      return "unauthorized";
    if (/limit|throttle|too many/.test(msg)) return "rate_limited";
    if (/does not exist|no such|not found|invalid series/.test(msg))
      return "invalid_series";
    return "api_error";
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 404) return "invalid_series";
  if (status < 200 || status >= 300) return "api_error";
  return "ok";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface FredSeriesMeta {
  seriesCode: string;
  title: string | null;
  frequency: string | null;
  frequencyShort: string | null;
  units: string | null;
  seasonalAdjustment: string | null;
  notes: string | null;
}

/** series endpoint → {seriess: [{id,title,frequency,units,...}]} */
export function parseFredSeriesMeta(
  payload: unknown,
): { kind: "meta"; meta: FredSeriesMeta } | { kind: "error"; detail: string } {
  const p = payload as Record<string, unknown>;
  const arr = p?.seriess;
  if (!Array.isArray(arr) || arr.length === 0)
    return {
      kind: "error",
      detail: `missing seriess[]: keys=${Object.keys(p ?? {})}`,
    };
  const s = arr[0] as Record<string, unknown>;
  if (typeof s.id !== "string" || s.id === "")
    return { kind: "error", detail: `seriess[0] missing id` };
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    kind: "meta",
    meta: {
      seriesCode: s.id,
      title: str(s.title),
      frequency: str(s.frequency),
      frequencyShort: str(s.frequency_short),
      units: str(s.units),
      seasonalAdjustment: str(s.seasonal_adjustment),
      notes: str(s.notes),
    },
  };
}

export interface FredObservation {
  obsDate: string; // observation period (DATE)
  vintageDate: string; // realtime_start — when this value was official
  value: string; // exact decimal
}
/** FRED '.' = missing — an absent value stays unknown; no row produced. */
export type FredObservationResult =
  | { kind: "observations"; observations: FredObservation[] }
  | { kind: "empty" }
  | { kind: "error"; detail: string };

export function parseFredObservations(payload: unknown): FredObservationResult {
  const p = payload as Record<string, unknown>;
  const arr = p?.observations;
  if (!Array.isArray(arr))
    return {
      kind: "error",
      detail: `missing observations[]: keys=${Object.keys(p ?? {})}`,
    };
  if (arr.length === 0) return { kind: "empty" };
  const out: FredObservation[] = [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] as Record<string, unknown>;
    const date = String(r.date ?? "");
    const vintage = String(r.realtime_start ?? "");
    if (!ISO_DATE.test(date))
      return {
        kind: "error",
        detail: `obs[${i}] invalid date: ${JSON.stringify(r.date)}`,
      };
    // realtime_start may be "YYYY-MM-DD HH:MM:SS±HH" on some endpoints —
    // keep the date part only
    const vintageDate = vintage.slice(0, 10);
    if (!ISO_DATE.test(vintageDate))
      return {
        kind: "error",
        detail: `obs[${i}] invalid realtime_start: ${JSON.stringify(r.realtime_start)}`,
      };
    const raw = r.value;
    if (raw === "." || raw === null || raw === undefined || raw === "")
      continue; // provider-declared missing — stays unknown, no row
    const value = normalizeDecimalString(raw);
    if (value == null)
      return {
        kind: "error",
        detail: `obs[${i}] invalid value: ${JSON.stringify(raw)}`,
      };
    out.push({ obsDate: date, vintageDate, value });
  }
  if (out.length === 0) return { kind: "empty" };
  return { kind: "observations", observations: out };
}

/* ---- World Bank ----
 * WB returns [meta, data[]] with annual rows; value may be null (unknown).
 * WB exposes no vintage dates — the caller supplies vintageDate (fetch
 * date) and the apply layer's stableVintage mode suppresses churn when
 * values are unchanged. */

export function parseWorldBankObservations(
  payload: unknown,
  vintageDate: string,
): FredObservationResult {
  const arr = Array.isArray(payload) ? payload[1] : undefined;
  if (!Array.isArray(arr))
    return {
      kind: "error",
      detail: `missing data[]: keys=${Object.keys(payload ?? {})}`,
    };
  if (arr.length === 0) return { kind: "empty" };
  const out: FredObservation[] = [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] as Record<string, unknown>;
    const year = String(r.date ?? "");
    if (!/^\d{4}$/.test(year))
      return {
        kind: "error",
        detail: `obs[${i}] invalid year: ${JSON.stringify(r.date)}`,
      };
    const raw = r.value;
    if (raw === null || raw === undefined || raw === "") continue;
    const value = normalizeDecimalString(raw);
    if (value == null)
      return {
        kind: "error",
        detail: `obs[${i}] invalid value: ${JSON.stringify(raw)}`,
      };
    // Annual series: obsDate = Jan 1 of the reported year
    out.push({ obsDate: `${year}-01-01`, vintageDate, value });
  }
  if (out.length === 0) return { kind: "empty" };
  return { kind: "observations", observations: out };
}
