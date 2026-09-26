/* Market Data Foundation — pure derivation layer.
 *
 * V1 semantics:
 *   identity   = market_series (FK instrument_listings) — NEVER ticker
 *   point      = (series_id, session_date) — DATE, not fake UTC midnight
 *   fact       = append-only market_point_versions, numeric (not float)
 *   provenance = every version → reference_observations.id (raw payload)
 *
 * Provider: Alpha Vantage TIME_SERIES_DAILY (raw as-traded, regular
 * session). TIME_SERIES_DAILY_ADJUSTED is deliberately unused — adjusted
 * semantics need a separate documented basis before they can be stored.
 */

// ── Alpha Vantage TIME_SERIES_DAILY ──────────────────────────────────────

export interface DailyBar {
  /** YYYY-MM-DD market session date */
  sessionDate: string;
  /** decimal strings — preserve provider precision into numeric columns */
  open: string;
  high: string;
  low: string;
  close: string;
  /** null when provider omits it — never coerced to 0 */
  volume: string | null;
}

export type ProviderErrorClass =
  "rate_limit" | "invalid_symbol" | "api_error" | "empty" | "unexpected_schema";

export type AvDailyResult =
  | {
      kind: "series";
      bars: DailyBar[];
      meta: { symbol?: string; lastRefreshed?: string; timezone?: string };
    }
  | { kind: "provider_error"; errorClass: ProviderErrorClass; detail: string };

/** Parse + classify an Alpha Vantage TIME_SERIES_DAILY payload.
 *  Rate-limit notes and error messages are NEVER mistaken for an empty
 *  successful series. */
export function parseAvDaily(payload: unknown): AvDailyResult {
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;

  // Alpha Vantage error surfaces: three distinct message keys
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

  const meta = (p["Meta Data"] ?? {}) as Record<string, unknown>;
  const series = p["Time Series (Daily)"];
  if (series == null)
    return Object.keys(p).length === 0
      ? { kind: "provider_error", errorClass: "empty", detail: "{}" }
      : {
          kind: "provider_error",
          errorClass: "unexpected_schema",
          detail: `missing "Time Series (Daily)" — keys: ${Object.keys(p).join(",")}`,
        };
  if (typeof series !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `"Time Series (Daily)" is ${typeof series}`,
    };

  const bars: DailyBar[] = [];
  for (const [date, v] of Object.entries(series as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `bad session date key ${JSON.stringify(date)}`,
      };
    const o = v as Record<string, unknown>;
    const bar: DailyBar = {
      sessionDate: date,
      open: String(o["1. open"] ?? ""),
      high: String(o["2. high"] ?? ""),
      low: String(o["3. low"] ?? ""),
      close: String(o["4. close"] ?? ""),
      volume:
        o["5. volume"] == null || o["5. volume"] === ""
          ? null
          : String(o["5. volume"]),
    };
    bars.push(bar);
  }
  if (!bars.length)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: "time series object has zero dates",
    };
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return {
    kind: "series",
    bars,
    meta: {
      symbol:
        typeof meta["2. Symbol"] === "string"
          ? (meta["2. Symbol"] as string)
          : undefined,
      lastRefreshed:
        typeof meta["3. Last Refreshed"] === "string"
          ? (meta["3. Last Refreshed"] as string)
          : undefined,
      timezone:
        typeof meta["5. Time Zone"] === "string"
          ? (meta["5. Time Zone"] as string)
          : undefined,
    },
  };
}

// ── bar validation (Phase 7) ─────────────────────────────────────────────

export type BarValidation = { ok: true } | { ok: false; reason: string };

/** OHLC sanity. Provider values are never "fixed" — a bad bar is rejected,
 *  its raw observation preserved, and the failure lands in the audit. */
export function validateBar(b: DailyBar): BarValidation {
  const num = (s: string | null) => (s == null || s === "" ? null : Number(s));
  const [o, h, l, c] = [num(b.open), num(b.high), num(b.low), num(b.close)];
  for (const [name, v] of [
    ["open", o],
    ["high", h],
    ["low", l],
    ["close", c],
  ] as const) {
    if (v == null || !Number.isFinite(v))
      return { ok: false, reason: `unparseable_${name}` };
    if (v <= 0) return { ok: false, reason: `nonpositive_${name}` };
  }
  const vol = num(b.volume);
  if (b.volume != null && (vol == null || !Number.isFinite(vol)))
    return { ok: false, reason: "unparseable_volume" };
  if (vol != null && vol < 0) return { ok: false, reason: "negative_volume" };
  // OHLC envelope
  if (l! > h!) return { ok: false, reason: "low_gt_high" };
  if (o! < l! || o! > h!) return { ok: false, reason: "open_outside_range" };
  if (c! < l! || c! > h!) return { ok: false, reason: "close_outside_range" };
  return { ok: true };
}

// ── point-version comparator (Phase 6) ───────────────────────────────────
// All persisted semantic fields compared: open, high, low, close, volume,
// currency. provenance columns (observation_id, previous_version_id,
// observed_at) excluded.

const normNum = (v: unknown): string => {
  if (v == null || v === "") return "";
  // pg numeric/bigint comes back as string; provider payloads are decimal
  // strings too — compare as numbers but bail out safely on weird input
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) return String(v);
  return String(n);
};

export function marketPointChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  for (const f of ["open", "high", "low", "close"] as const)
    if (normNum(cur[f]) !== normNum(next[f])) return true;
  for (const f of ["volume", "currency"] as const) {
    const a = cur[f] == null ? "" : String(cur[f]);
    const b = next[f] == null ? "" : String(next[f]);
    if (a !== b) return true;
  }
  return false;
}

// ── return helpers (Phase 21 — pure, not persisted) ──────────────────────

/** Simple return: close/prev − 1. null when inputs unusable. */
export function simpleReturn(
  prevClose: number | string,
  close: number | string,
): number | null {
  const p = Number(prevClose);
  const c = Number(close);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0) return null;
  return c / p - 1;
}

/** Log return: ln(close/prev). null when inputs unusable. */
export function logReturn(
  prevClose: number | string,
  close: number | string,
): number | null {
  const p = Number(prevClose);
  const c = Number(close);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || c <= 0)
    return null;
  return Math.log(c / p);
}
