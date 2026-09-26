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

// ── exact decimal semantics ──────────────────────────────────────────────
// Market facts persist as PostgreSQL numeric — comparators must not pull
// IEEE-754 into the loop (9007199254740992 ≠ 9007199254740993 stays
// distinct; 100 = 100.0 = 100.0000 compare equal).

/** Canonical decimal string. Accepts ordinary decimal notation only —
 *  exponential/hex/malformed input returns null rather than being
 *  silently reinterpreted. */
export function normalizeDecimalString(v: unknown): string | null {
  if (v == null) return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  const int = m[2].replace(/^0+/, "") || "0";
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const canon = frac ? `${int}.${frac}` : int;
  if (canon === "0") return "0"; // -0.000 → 0
  return m[1] === "-" ? `-${canon}` : canon;
}

/** -1 | 0 | 1 over canonical decimal strings (NaN-safe callers only —
 *  validateBar rejects non-canonical input before comparing). */
export function compareDecimals(a: string, b: string): number {
  const na = a.startsWith("-");
  const nb = b.startsWith("-");
  if (na !== nb) return na ? -1 : 1;
  const [ia, fa = ""] = (na ? a.slice(1) : a).split(".");
  const [ib, fb = ""] = (nb ? b.slice(1) : b).split(".");
  let c = ia.length - ib.length || (ia > ib ? 1 : ia < ib ? -1 : 0);
  if (!c) {
    const fl = Math.max(fa.length, fb.length);
    const pa = fa.padEnd(fl, "0");
    const pb = fb.padEnd(fl, "0");
    c = pa > pb ? 1 : pa < pb ? -1 : 0;
  }
  return na ? -c : c;
}

/** PostgreSQL bigint domain: integer string, |v| ≤ 2^63-1 / 2^63. */
export function isBigintString(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) return false;
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).replace(/^0+/, "") || "0";
  // |bigint| bounds — string-compared, no Number() involved
  const limit = neg ? "9223372036854775808" : "9223372036854775807";
  return (
    digits.length < limit.length ||
    (digits.length === limit.length && digits <= limit)
  );
}

// ── bar validation (Phase 7) ─────────────────────────────────────────────

export type BarValidation = { ok: true } | { ok: false; reason: string };

/** OHLC sanity on exact decimals. Provider values are never "fixed" — a
 *  bad bar is rejected, its raw observation preserved, and the failure
 *  lands in the audit. */
export function validateBar(b: DailyBar): BarValidation {
  const num = (s: string | null) =>
    s == null || s === "" ? null : normalizeDecimalString(s);
  const [o, h, l, c] = [num(b.open), num(b.high), num(b.low), num(b.close)];
  for (const [name, v] of [
    ["open", o],
    ["high", h],
    ["low", l],
    ["close", c],
  ] as const) {
    if (v == null) return { ok: false, reason: `unparseable_${name}` };
    if (compareDecimals(v, "0") <= 0)
      return { ok: false, reason: `nonpositive_${name}` };
  }
  if (b.volume != null && !isBigintString(b.volume))
    return { ok: false, reason: "unparseable_volume" };
  if (
    b.volume != null &&
    compareDecimals(normalizeDecimalString(b.volume)!, "0") < 0
  )
    return { ok: false, reason: "negative_volume" };
  // OHLC envelope
  if (compareDecimals(l!, h!) > 0) return { ok: false, reason: "low_gt_high" };
  if (compareDecimals(o!, l!) < 0 || compareDecimals(o!, h!) > 0)
    return { ok: false, reason: "open_outside_range" };
  if (compareDecimals(c!, l!) < 0 || compareDecimals(c!, h!) > 0)
    return { ok: false, reason: "close_outside_range" };
  return { ok: true };
}

// ── point-version comparator (Phase 6) ───────────────────────────────────
// All persisted semantic fields compared: open, high, low, close, volume,
// currency. provenance columns (observation_id, previous_version_id,
// observed_at) excluded.

export function marketPointChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  for (const f of ["open", "high", "low", "close", "volume"] as const) {
    const a =
      cur[f] == null ? "" : (normalizeDecimalString(cur[f]) ?? `!${cur[f]}`);
    const b =
      next[f] == null ? "" : (normalizeDecimalString(next[f]) ?? `!${next[f]}`);
    if (a !== b) return true;
  }
  const ca = cur.currency == null ? "" : String(cur.currency);
  const cb = next.currency == null ? "" : String(next.currency);
  return ca !== cb;
}

// ── provider transport-symbol resolution (Phase: symbol ≠ identity) ──────
// A provider request symbol is transport only. Alpha Vantage's plain-ticker
// form is valid only for the US equity venues we explicitly support.

export const AV_US_EQUITY_MICS = new Set([
  "XNAS", // Nasdaq — all markets
  "XNGS", // Nasdaq Global Select
  "XNCM", // Nasdaq Capital Market
  "XNYS", // NYSE
  "XASE", // NYSE American
  "ARCX", // NYSE Arca
  "BATS", // Cboe BZX
  "IEXG", // IEX
]);

export type AvSymbolResolution =
  | { kind: "symbol"; symbol: string }
  | { kind: "unresolved_provider_symbol"; reason: string };

/** Map a listing to its Alpha Vantage transport symbol. Unsupported venues
 *  return unresolved — never a guessed symbol. */
export function resolveAlphaVantageSymbol(listing: {
  mic: string | null | undefined;
  ticker: string | null | undefined;
}): AvSymbolResolution {
  const t = listing.ticker?.trim();
  if (!t) return { kind: "unresolved_provider_symbol", reason: "no_ticker" };
  if (!listing.mic || !AV_US_EQUITY_MICS.has(listing.mic))
    return {
      kind: "unresolved_provider_symbol",
      reason: `unsupported_venue:${listing.mic ?? "none"}`,
    };
  return { kind: "symbol", symbol: t };
}

/** Real calendar date 'YYYY-MM-DD' — rejects 2026-99-99 / 2026-02-31,
 *  unlike a shape regex alone. */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
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
