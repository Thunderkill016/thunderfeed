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

/** Tiingo's US-equity coverage uses the plain ticker over the same
 *  verified US venue set — unsupported venue → unresolved, never guessed. */
export function resolveTiingoSymbol(listing: {
  mic: string | null | undefined;
  ticker: string | null | undefined;
}): AvSymbolResolution {
  return resolveAlphaVantageSymbol(listing); // same verified US MIC policy
}

// ── Tiingo EOD adapter ───────────────────────────────────────────────────
// Endpoint: GET /tiingo/daily/<ticker>/prices?format=csv
// Auth: Authorization: Token <TIINGO_API_TOKEN> — the token NEVER enters
// the URL, logs, or reference_observations.source_url.
// Raw CSV stores: open..volume PLUS adj*/divCash/splitFactor — one raw
// observation feeds THREE lawful derivations: as_traded bars (raw OHLCV),
// provider_adjusted bars (the provider's own adj* columns — never
// recomputed), and corporate-action hints (divCash≠0 / splitFactor≠1).

export type TiingoErrorClass =
  | "unauthorized"
  | "rate_limit"
  | "invalid_symbol"
  | "empty"
  | "unexpected_schema"
  | "api_error";

/** Corporate-action hint embedded in a Tiingo EOD row — ex_date is the
 *  row's session date; divCash/splitFactor are provider assertions, not
 *  inputs to any homemade adjustment formula. */
export interface TiingoActionHint {
  exDate: string;
  divCash: string;
  splitFactor: string;
}

export type TiingoEodResult =
  | {
      kind: "series";
      bars: DailyBar[];
      /** provider-supplied adjusted bars (adjOpen..adjVolume) — a SECOND
       *  series assertion (price_basis='provider_adjusted'), never merged
       *  into as_traded and never computed locally */
      adjustedBars: DailyBar[] | null;
      /** rows where divCash≠0 or splitFactor≠1 — CA assertions keyed by
       *  the row's session date as ex-date */
      actionHints: TiingoActionHint[];
      meta: { columns: string[]; rows: number };
    }
  | { kind: "provider_error"; errorClass: TiingoErrorClass; detail: string };

/** Minimal RFC-4180 CSV: quoted fields, "" escapes, CRLF/LF. Returns rows
 *  of raw string cells — nothing passes through Number(). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue; // CR of CRLF
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Classify + parse a Tiingo EOD response. `status` is the HTTP code;
 *  `body` is raw text (CSV on success, JSON/text error otherwise). */
export function parseTiingoEod(res: {
  status: number;
  body: string;
}): TiingoEodResult {
  const { status, body } = res;
  if (status === 401 || status === 403)
    return {
      kind: "provider_error",
      errorClass: "unauthorized",
      detail: body.slice(0, 200),
    };
  if (status === 404)
    return {
      kind: "provider_error",
      errorClass: "invalid_symbol",
      detail: body.slice(0, 200),
    };
  if (status === 429)
    return {
      kind: "provider_error",
      errorClass: "rate_limit",
      detail: body.slice(0, 200),
    };
  if (status < 200 || status >= 300)
    return {
      kind: "provider_error",
      errorClass: "api_error",
      detail: `HTTP ${status}: ${body.slice(0, 160)}`,
    };
  const trimmed = body.trim();
  if (!trimmed)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: "empty body",
    };
  // an unexpected JSON/HTML body in place of CSV is a schema error, not a
  // zero-bar success
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `JSON body on CSV request: ${trimmed.slice(0, 120)}`,
    };

  const rows = parseCsv(body);
  if (!rows.length)
    return { kind: "provider_error", errorClass: "empty", detail: "no rows" };
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  for (const need of ["date", "open", "high", "low", "close", "volume"])
    if (col(need) < 0)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `missing column '${need}' — header: ${header.join(",")}`,
      };

  const bars: DailyBar[] = [];
  const adjustedBars: DailyBar[] = [];
  const actionHints: TiingoActionHint[] = [];
  // adjusted + CA columns are optional on the provider side
  const adjIdx = {
    open: col("adjOpen"),
    high: col("adjHigh"),
    low: col("adjLow"),
    close: col("adjClose"),
    volume: col("adjVolume"),
  };
  const hasAdjusted = Object.values(adjIdx).every((i) => i >= 0);
  const divIdx = col("divCash");
  const splitIdx = col("splitFactor");
  for (const [i, r] of rows.slice(1).entries()) {
    if (r.length === 1 && r[0].trim() === "") continue; // trailing blank line
    if (r.length !== header.length)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `row ${i + 2} has ${r.length} fields, header has ${header.length}`,
      };
    const raw = r[col("date")].trim();
    // Tiingo emits 'YYYY-MM-DD' or 'YYYY-MM-DDT00:00:00.000Z'; the market
    // session date is the date part — no timezone shifting
    const sessionDate = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1];
    if (!sessionDate)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `bad date '${raw}' on row ${i + 2}`,
      };
    const volRaw = r[col("volume")].trim();
    bars.push({
      sessionDate,
      open: r[col("open")].trim(),
      high: r[col("high")].trim(),
      low: r[col("low")].trim(),
      close: r[col("close")].trim(),
      volume: volRaw === "" ? null : volRaw, // unknown stays NULL, never 0
    });
    if (hasAdjusted) {
      const adjVol = r[adjIdx.volume].trim();
      adjustedBars.push({
        sessionDate,
        open: r[adjIdx.open].trim(),
        high: r[adjIdx.high].trim(),
        low: r[adjIdx.low].trim(),
        close: r[adjIdx.close].trim(),
        volume: adjVol === "" ? null : adjVol,
      });
    }
    const divCash = divIdx >= 0 ? r[divIdx].trim() : "";
    const splitFactor = splitIdx >= 0 ? r[splitIdx].trim() : "";
    // CA hints: any nonzero dividend or non-1 split factor on this row
    // is a provider assertion with ex_date = the session date. Malformed
    // decimals (normalize → null) never become hints.
    const nd = divCash === "" ? null : normalizeDecimalString(divCash);
    const ns = splitFactor === "" ? null : normalizeDecimalString(splitFactor);
    const isDiv = nd != null && nd !== "0";
    const isSplit = ns != null && ns !== "1";
    if (isDiv || isSplit)
      actionHints.push({ exDate: sessionDate, divCash, splitFactor });
  }
  if (!bars.length)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: "CSV header but zero data rows",
    };
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  adjustedBars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  actionHints.sort((a, b) => a.exDate.localeCompare(b.exDate));
  return {
    kind: "series",
    bars,
    adjustedBars: hasAdjusted ? adjustedBars : null,
    actionHints,
    meta: { columns: header, rows: bars.length },
  };
}

// ── dual-provider comparison (diagnostics only — never persisted as fact) ─

export type DayAgreement =
  "exact_agreement" | "price_divergence" | "volume_divergence";

export type SessionComparison =
  | { kind: "missing_in_alpha"; sessionDate: string }
  | { kind: "missing_in_tiingo"; sessionDate: string }
  | {
      kind: "compared";
      sessionDate: string;
      agreement: DayAgreement;
      alpha: {
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string | null;
      };
      tiingo: {
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string | null;
      };
      divergentFields: ("open" | "high" | "low" | "close" | "volume")[];
      /** labeled diagnostic: |Δclose| and Δbps use binary float for
       *  magnitude ONLY — equality decisions stay exact-decimal */
      closeDiff: number;
      closeDiffBps: number;
      volumeDiff: number | null;
      volumeDiffPct: number | null;
    };

const decEq = (a: string | null, b: string | null): boolean => {
  if (a == null || b == null) return a == null && b == null;
  const na = normalizeDecimalString(a);
  const nb = normalizeDecimalString(b);
  return na != null && nb != null && na === nb;
};

/** Compare two providers' daily series for the SAME listing — two
 *  independent assertions; a divergence is recorded, never averaged or
 *  silently resolved. */
export function compareDailySeries(
  alphaBars: DailyBar[],
  tiingoBars: DailyBar[],
): SessionComparison[] {
  const byA = new Map(alphaBars.map((b) => [b.sessionDate, b]));
  const byT = new Map(tiingoBars.map((b) => [b.sessionDate, b]));
  const dates = [...new Set([...byA.keys(), ...byT.keys()])].sort();
  const out: SessionComparison[] = [];
  for (const d of dates) {
    const a = byA.get(d);
    const t = byT.get(d);
    if (!a) {
      out.push({ kind: "missing_in_alpha", sessionDate: d });
      continue;
    }
    if (!t) {
      out.push({ kind: "missing_in_tiingo", sessionDate: d });
      continue;
    }
    const divergentFields = (
      ["open", "high", "low", "close", "volume"] as const
    ).filter((f) => !decEq(a[f], t[f]));
    const priceDiff = divergentFields.filter((f) => f !== "volume");
    const agreement: DayAgreement = divergentFields.length
      ? priceDiff.length
        ? "price_divergence"
        : "volume_divergence"
      : "exact_agreement";
    const ca = Number(a.close);
    const ct = Number(t.close);
    const va = a.volume == null ? null : Number(a.volume);
    const vt = t.volume == null ? null : Number(t.volume);
    out.push({
      kind: "compared",
      sessionDate: d,
      agreement,
      alpha: {
        open: a.open,
        high: a.high,
        low: a.low,
        close: a.close,
        volume: a.volume,
      },
      tiingo: {
        open: t.open,
        high: t.high,
        low: t.low,
        close: t.close,
        volume: t.volume,
      },
      divergentFields,
      closeDiff: Math.abs(ct - ca), // diagnostic only
      closeDiffBps:
        Number.isFinite(ca) && ca !== 0
          ? Math.round(((ct - ca) / ca) * 1e6) / 100 // bps, 2 decimals
          : 0,
      volumeDiff: va == null || vt == null ? null : Math.abs(vt - va),
      volumeDiffPct:
        va == null || vt == null || va === 0
          ? null
          : Math.round(((vt - va) / va) * 1e4) / 100,
    });
  }
  return out;
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

/** DATE column → 'YYYY-MM-DD'. pg driver returns Date parsed as LOCAL
 *  midnight — toISOString() would shift the day in UTC+N timezones, so the
 *  local getters are used deliberately: the date is a label, not an
 *  instant. pg-mem may hand back the same shape or a bare string. */
export function isoDay(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
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

// ── VNDirect dchart adapter (VN equities + HOSE indices) ─────────────────
// Endpoint: GET https://dchart-api.vndirect.com.vn/dchart/history
//   ?symbol=<TICKER>&resolution=D&from=<unix_s>&to=<unix_s>
// No auth. Response: {t:[unix_s],o:[],h:[],l:[],c:[],v:[],s:"ok"}.
// Units: equity prices arrive in THOUSAND VND (VNM 56.513 → 56,513₫);
// index values are index points (VNINDEX ~1,660). The caller declares
// priceScale per symbol — canonical storage is full VND; the raw payload
// is preserved verbatim in reference_observations either way.

/** HOSE operating MIC is XSTC; HNX/UPCOM (XHNX/XUPX) aren't imported yet. */
/** % change between two session closes — Number() is fine here (display +
 *  materiality gate only; canonical values stay decimal text). Returns
 *  null when either side is missing or prev is zero. */
export function dailyMovePct(
  prevClose: unknown,
  close: unknown,
): number | null {
  const p = Number(prevClose);
  const c = Number(close);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

/** Median of a finite sample — null on empty input. A median baseline is
 *  robust to a single outlier session, which is the whole point of the
 *  volume_spike comparator. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const VNDIRECT_VN_MICS = new Set(["XSTC", "HSTC", "XHNX"]);

export function resolveVndirectSymbol(listing: {
  mic: string | null | undefined;
  ticker: string | null | undefined;
}): AvSymbolResolution {
  const t = listing.ticker?.trim();
  if (!t) return { kind: "unresolved_provider_symbol", reason: "no_ticker" };
  if (!listing.mic || !VNDIRECT_VN_MICS.has(listing.mic))
    return {
      kind: "unresolved_provider_symbol",
      reason: `unsupported_venue:${listing.mic ?? "none"}`,
    };
  return { kind: "symbol", symbol: t };
}

/** Exact decimal ×10^n via point-shift — never Number(), so
 *  56.513×10^3 is "56513", not 56512.999999999. Returns null on
 *  input normalizeDecimalString already rejects. */
export function shiftDecimal(v: unknown, places: number): string | null {
  const s = normalizeDecimalString(v);
  if (s == null || places === 0) return s;
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = s.replace("-", "").split(".");
  const digits = intPart + fracPart;
  const pointAt = intPart.length + places;
  let out: string;
  if (pointAt >= digits.length) {
    out = digits + "0".repeat(pointAt - digits.length);
  } else if (pointAt <= 0) {
    out = "0." + "0".repeat(-pointAt) + digits;
  } else {
    out = digits.slice(0, pointAt) + "." + digits.slice(pointAt);
  }
  // re-normalize: trims leading zeros the shift may have introduced
  return normalizeDecimalString((neg ? "-" : "") + out);
}

export type VndirectErrorClass =
  "invalid_symbol" | "empty" | "unexpected_schema" | "api_error";

export type VndirectResult =
  | { kind: "series"; bars: DailyBar[]; meta: { symbol?: string } }
  | {
      kind: "provider_error";
      errorClass: VndirectErrorClass;
      detail: string;
    };

/** Parse a VNDirect dchart/history payload. `s:"ok"` with empty arrays is
 *  a genuine empty window; non-ok status is a provider refusal — never
 *  mistaken for a successful series. priceScale is an integer power of
 *  ten (3 for thousand-VND equities, 0 for index points). */
export function parseVndirectHistory(
  payload: unknown,
  opts: { priceScale?: number } = {},
): VndirectResult {
  const scale = opts.priceScale ?? 0;
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;
  if (typeof p.s === "string" && p.s !== "ok")
    return {
      kind: "provider_error",
      errorClass: p.s === "no_data" ? "empty" : "api_error",
      detail: `provider status: ${p.s}`,
    };
  const t = p.t,
    o = p.o,
    h = p.h,
    l = p.l,
    c = p.c,
    v = p.v;
  for (const [name, arr] of Object.entries({ t, o, h, l, c, v })) {
    if (!Array.isArray(arr))
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `missing or non-array '${name}' — keys: ${Object.keys(p).join(",")}`,
      };
  }
  if (!(t as unknown[]).length)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: "zero bars",
    };
  const bars: DailyBar[] = [];
  for (let i = 0; i < (t as unknown[]).length; i++) {
    const ts = (t as unknown[])[i];
    if (typeof ts !== "number" || !Number.isFinite(ts))
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `t[${i}] not a number: ${JSON.stringify(ts)}`,
      };
    const open = shiftDecimal((o as unknown[])[i], scale);
    const high = shiftDecimal((h as unknown[])[i], scale);
    const low = shiftDecimal((l as unknown[])[i], scale);
    const close = shiftDecimal((c as unknown[])[i], scale);
    if (open == null || high == null || low == null || close == null)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `bar[${i}] has non-decimal price`,
      };
    const vol = (v as unknown[])[i];
    bars.push({
      sessionDate: new Date(ts * 1000).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume:
        vol == null || !Number.isFinite(Number(vol))
          ? null
          : String(Math.trunc(Number(vol))),
    });
  }
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return { kind: "series", bars, meta: {} };
}

// ── Alt-asset providers ──────────────────────────────────────────────────

export type GiavangErrorClass = "empty" | "unexpected_schema" | "api_error";

export type GiavangResult =
  | { kind: "series"; bars: DailyBar[] }
  | { kind: "provider_error"; errorClass: GiavangErrorClass; detail: string };

/** giavang.now /api/prices?type=<code>&days=N → daily quote bars.
 *  Gold boards quote a bid/ask pair, not trades — the 'quoted' convention
 *  keeps both: open=low=buy, high=close=sell. When the board only gives a
 *  single price (world spot sell=0) all four collapse to that quote.
 *  success:false is a provider refusal; a missing price map is an empty
 *  window, not a schema break. */
export function parseGiavangHistory(
  payload: unknown,
  opts: { code: string },
): GiavangResult {
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;
  if (p.success === false)
    return {
      kind: "provider_error",
      errorClass: "api_error",
      detail: `provider error: ${String(p.error ?? p.message ?? "unknown")}`,
    };
  if (!Array.isArray(p.history))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `missing 'history' array — keys: ${Object.keys(p).join(",")}`,
    };
  const bars: DailyBar[] = [];
  for (const [i, day] of (p.history as unknown[]).entries()) {
    const d = day as Record<string, unknown>;
    const prices = d?.prices as Record<string, unknown> | undefined;
    const quote = prices?.[opts.code] as Record<string, unknown> | undefined;
    if (typeof d?.date !== "string" || !isCalendarDate(d.date))
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `history[${i}] bad date: ${JSON.stringify(d?.date)}`,
      };
    if (quote == null) continue; // day has other products — not ours
    const buy = normalizeDecimalString(quote.buy);
    const sell = normalizeDecimalString(quote.sell);
    if (buy == null)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `history[${i}] non-decimal buy: ${JSON.stringify(quote.buy)}`,
      };
    // sell=0 means "no ask quoted" (world spot) — collapse to buy
    const ask = sell == null || compareDecimals(sell, "0") <= 0 ? buy : sell;
    bars.push({
      sessionDate: d.date,
      open: buy,
      high: ask,
      low: buy,
      close: ask,
      volume: null,
    });
  }
  if (!bars.length)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: `no days contain '${opts.code}'`,
    };
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return { kind: "series", bars };
}

export type BinanceErrorClass = "empty" | "unexpected_schema";

export type BinanceResult =
  | { kind: "series"; bars: DailyBar[] }
  | { kind: "provider_error"; errorClass: BinanceErrorClass; detail: string };

/** Binance GET /api/v3/klines — real traded OHLCV, 'as_traded'.
 *  Row: [openTime, open, high, low, close, volume, closeTime, ...].
 *  openTime is UTC-midnight ms for 1d klines; sessionDate derives from it.
 *  A live (still-open) candle is rejected upstream by the caller passing
 *  an `end` bound — here we only validate shape. */
export function parseBinanceKlines(payload: unknown): BinanceResult {
  if (!Array.isArray(payload))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an array",
    };
  if (!payload.length)
    return {
      kind: "provider_error",
      errorClass: "empty",
      detail: "zero klines",
    };
  const bars: DailyBar[] = [];
  for (const [i, row] of payload.entries()) {
    if (!Array.isArray(row) || row.length < 6)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `klines[${i}] malformed: ${JSON.stringify(row).slice(0, 120)}`,
      };
    const openTime = row[0];
    if (typeof openTime !== "number" || !Number.isFinite(openTime))
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `klines[${i}] bad openTime: ${JSON.stringify(openTime)}`,
      };
    const open = normalizeDecimalString(row[1]);
    const high = normalizeDecimalString(row[2]);
    const low = normalizeDecimalString(row[3]);
    const close = normalizeDecimalString(row[4]);
    if (open == null || high == null || low == null || close == null)
      return {
        kind: "provider_error",
        errorClass: "unexpected_schema",
        detail: `klines[${i}] non-decimal OHLC`,
      };
    const vol = Number(row[5]);
    bars.push({
      sessionDate: new Date(openTime).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: Number.isFinite(vol) ? String(Math.trunc(vol)) : null,
    });
  }
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return { kind: "series", bars };
}

/** open.er-api.com/v6/latest/<base> — single reference rate per day.
 *  A reference rate is a point estimate, not a traded range: all four bar
 *  fields carry the same value. result:'error' is a provider refusal. */
export function parseErApiRate(
  payload: unknown,
  opts: { quote: string },
): GiavangResult {
  if (payload == null || typeof payload !== "object")
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: "payload is not an object",
    };
  const p = payload as Record<string, unknown>;
  if (p.result !== "success")
    return {
      kind: "provider_error",
      errorClass: "api_error",
      detail: `provider result: ${String(p.result ?? "missing")}`,
    };
  const rates = p.rates as Record<string, unknown> | undefined;
  const rate = normalizeDecimalString(rates?.[opts.quote]);
  const dateRaw = p.time_last_update_utc ?? p.time_last_update_unix;
  if (rate == null || dateRaw == null)
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `missing rates.${opts.quote} or timestamp`,
    };
  // er-api stamps "Mon, 28 Sep 2026 00:00:01 +0000" (RFC) or a unix number
  const sessionDate = isCalendarDate(String(dateRaw).slice(0, 10))
    ? String(dateRaw).slice(0, 10)
    : new Date(typeof dateRaw === "number" ? dateRaw * 1000 : String(dateRaw))
        .toISOString()
        .slice(0, 10);
  if (!isCalendarDate(sessionDate))
    return {
      kind: "provider_error",
      errorClass: "unexpected_schema",
      detail: `unparseable rate date: ${JSON.stringify(dateRaw)}`,
    };
  return {
    kind: "series",
    bars: [
      {
        sessionDate,
        open: rate,
        high: rate,
        low: rate,
        close: rate,
        volume: null,
      },
    ],
  };
}

// ── Derived series: SJC-vs-world gold premium ────────────────────────────

/** 1 lượng (VN tael) = 37.5 g; troy ounce = 31.1034768 g. The SJC retail
 *  board quotes VND/lượng while the world spot quotes USD/troy oz, so
 *  comparing them needs both the weight and FX conversions — the premium
 *  is computed, never fetched. */
export const LUONG_PER_TROY_OZ = 37.5 / 31.1034768;

export interface PremiumLegs {
  /** SJC board ask — what a VN buyer pays, VND/lượng */
  sjcSell: number;
  /** world spot, USD/troy oz */
  xauUsd: number;
  /** USD/VND reference rate */
  usdVnd: number;
}

/** SJC premium over world, in %: sjc / (xau × fx × lượng-per-oz) − 1.
 *  A leg of 0/NaN yields null — never fabricate a premium. */
export function goldPremiumPct(legs: PremiumLegs): number | null {
  const world = legs.xauUsd * legs.usdVnd * LUONG_PER_TROY_OZ;
  // a 0 quote is "no quote" (giavang publishes sell=0 on single-price
  // rows), not a price — refuse rather than emit a −100% premium
  if (
    !Number.isFinite(world) ||
    world <= 0 ||
    !Number.isFinite(legs.sjcSell) ||
    legs.sjcSell <= 0
  )
    return null;
  return (legs.sjcSell / world - 1) * 100;
}

/** Per-date premium bars from aligned legs. Dates missing any leg are
 *  skipped (no interpolation); the bar is a point value so open=high=
 *  low=close, matching the single-quote convention. */
export function computePremiumBars(legs: Map<string, PremiumLegs>): DailyBar[] {
  const bars: DailyBar[] = [];
  for (const [sessionDate, l] of legs) {
    const pct = goldPremiumPct(l);
    if (pct == null) continue;
    const v = pct.toFixed(4);
    bars.push({
      sessionDate,
      open: v,
      high: v,
      low: v,
      close: v,
      volume: null,
    });
  }
  bars.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  return bars;
}
