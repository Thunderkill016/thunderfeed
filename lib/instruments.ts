/* Financial Instrument Master — pure derivation layer.
 *
 * Standards semantics (Phase 1 research, official sources):
 *   CIK      SEC EDGAR filer/entity id — lives in entity_identifiers,
 *            NEVER an instrument identifier.
 *   ISIN     ISO 6166 — identifies the financial/referential instrument
 *            (share class granularity), globally unique, venue-agnostic.
 *   MIC      ISO 10383 — identifies the trading venue (trading_venues.mic).
 *   ticker   market/listing symbol — listing state only, NOT globally unique.
 *   FIGI     OpenFIGI venue-level tradable-instrument id → listing scope.
 *   shareClassFIGI  global share-class grouping → instrument scope.
 *   compositeFIGI   country/market composite     → instrument scope.
 *
 * All functions here are pure — DB/network access lives in
 * scripts/instruments/*. Provider payloads are stored verbatim in
 * reference_observations; derived rows always carry observation_id.
 */

// ── ISO 10383 MIC ─────────────────────────────────────────────────────────

export interface MicRow {
  mic: string;
  operatingMic: string;
  micRole: "operating" | "segment";
  marketName: string;
  legalEntityName: string | null;
  lei: string | null;
  marketCategory: string | null;
  acronym: string | null;
  countryCode: string | null;
  city: string | null;
  status: "active" | "expired" | "updated";
  validFrom: string | null; // ISO date
  validTo: string | null;
}

/** Parse the official ISO 10383 CSV (16 fixed columns). */
export function parseIsoMicCsv(csvText: string): MicRow[] {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^"|"$/g, "").trim());
  const col = (name: string) => header.indexOf(name);
  const iMic = col("MIC");
  const iOpm = col("OPERATING MIC");
  const iRole = col("OPRT/SGMT");
  const iName = col("MARKET NAME-INSTITUTION DESCRIPTION");
  const iLegal = col("LEGAL ENTITY NAME");
  const iLei = col("LEI");
  const iCat = col("MARKET CATEGORY CODE");
  const iAcr = col("ACRONYM");
  const iCtry = col("ISO COUNTRY CODE (ISO 3166)");
  const iCity = col("CITY");
  const iStatus = col("STATUS");
  const iCreated = col("CREATION DATE");
  const iExpiry = col("EXPIRY DATE");
  if (iMic < 0 || iName < 0 || iStatus < 0)
    throw new Error("ISO10383 CSV: unexpected header layout");
  const isoDate = (v: string | undefined): string | null => {
    if (!v || !/^\d{8}$/.test(v)) return null;
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  };
  const out: MicRow[] = [];
  for (const r of rows.slice(1)) {
    const mic = r[iMic]?.trim();
    if (!mic) continue;
    const status = (r[iStatus] ?? "").trim().toUpperCase();
    out.push({
      mic,
      operatingMic: r[iOpm]?.trim() || mic,
      micRole:
        (r[iRole] ?? "").trim().toUpperCase() === "SGMT"
          ? "segment"
          : "operating",
      marketName: r[iName]?.trim() ?? "",
      legalEntityName: r[iLegal]?.trim() || null,
      lei: r[iLei]?.trim() || null,
      marketCategory: r[iCat]?.trim() || null,
      acronym: r[iAcr]?.trim() || null,
      countryCode: r[iCtry]?.trim() || null,
      city: r[iCity]?.trim() || null,
      status:
        status === "ACTIVE"
          ? "active"
          : status === "UPDATED"
            ? "updated"
            : "expired",
      validFrom: isoDate(r[iCreated]),
      validTo: isoDate(r[iExpiry]),
    });
  }
  return out;
}

/** Minimal RFC4180-ish CSV parser (quoted fields, embedded commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── SEC EDGAR company_tickers_exchange ─────────────────────────────────────

export interface SecTickerRow {
  cik: number;
  name: string;
  ticker: string;
  exchange: string; // free-form display name, e.g. "Nasdaq", "NYSE"
}

export function parseSecTickersExchange(payload: unknown): SecTickerRow[] {
  const p = payload as { fields?: string[]; data?: unknown[][] };
  if (!p?.fields || !Array.isArray(p.data))
    throw new Error("SEC company_tickers_exchange: unexpected shape");
  const f = p.fields;
  const i = {
    cik: f.indexOf("cik"),
    name: f.indexOf("name"),
    ticker: f.indexOf("ticker"),
    exchange: f.indexOf("exchange"),
  };
  return p.data
    .filter((r) => Array.isArray(r))
    .map((r) => ({
      cik: Number(r[i.cik]),
      name: String(r[i.name] ?? ""),
      ticker: String(r[i.ticker] ?? ""),
      exchange: String(r[i.exchange] ?? ""),
    }));
}

/** SEC exchange display names → ISO 10383 candidate MICs (segments first).
 *  SEC's 'Nasdaq' spans the Global Select / National / Capital tiers, so the
 *  venue MIC is resolved per-ticker from OpenFIGI responses rather than
 *  guessed once per exchange. Anything unmapped stays unresolved. */
export const SEC_EXCHANGE_MIC_CANDIDATES: Readonly<
  Record<string, readonly string[]>
> = {
  Nasdaq: ["XNGS", "XNMS", "XNCM"],
  NYSE: ["XNYS"],
  "NYSE American": ["XASE"],
  "Cboe BZX": ["BATS"],
  "Cboe BYX": ["BATY"],
  "Cboe EDGA": ["EDGA"],
  "Cboe EDGX": ["EDGX"],
  "NYSE Arca": ["ARCX"],
  "NYSE Chicago": ["XCHI"],
  "NYSE National": ["XCIS"],
};

// ── OpenFIGI mapping ───────────────────────────────────────────────────────

export interface FigiResult {
  figi?: string;
  name?: string;
  ticker?: string;
  exchCode?: string;
  micCode?: string;
  shareClassFIGI?: string;
  compositeFIGI?: string;
  cfi?: string; // ISO 10962 classification — not an identifier
  securityType?: string;
  securityType2?: string;
  securityDescription?: string;
  marketSector?: string;
  currency?: string;
  error?: string;
  warning?: string[];
}

/** OpenFIGI /v3/mapping response entry → results or per-job error. */
export function parseFigiMappingResponse(
  entry: unknown,
): { results: FigiResult[] } | { error: string } {
  const e = entry as { data?: FigiResult[]; error?: string };
  if (e?.error) return { error: e.error };
  return { results: Array.isArray(e?.data) ? e.data : [] };
}

/** Map OpenFIGI securityType2/securityType → our instrument_type.
 *  Returns null when the type isn't representable → record stays observed
 *  but no instrument is promoted. */
export function figiInstrumentType(r: FigiResult): string | null {
  const t = (r.securityType2 ?? r.securityType ?? "").toLowerCase();
  if (t === "common stock") return "common_stock";
  if (t === "preferred") return "preferred_stock";
  if (t === "adr" || t === "receipt") return "depositary_receipt";
  if (t === "etf" || t === "etp") return "etf";
  return null;
}

// ── derivation plan ───────────────────────────────────────────────────────

export type SeedOutcome =
  | { kind: "seeded"; canonicalKey: string }
  | { kind: "conflict"; reason: string }
  | { kind: "unresolved"; reason: string };

export interface SeedInput {
  issuerSlug: string; // entity canonical_key suffix, e.g. 'alphabet'
  secRow: SecTickerRow; // SEC ticker↔CIK association (discovery only)
  /** venue candidates with their OpenFIGI mapping results — one listing per
   *  MIC that returned data (multi-venue is real, not a conflict) */
  venues: { mic: string; obsId: string; results: FigiResult[] }[];
}

export interface ListingSeedPlan {
  listingKey: string; // 'listing:alphabet:class_a_common_stock:xngs'
  mic: string;
  ticker: string;
  currency: string | null;
  figi: string;
  obsId: string; // provenance
}

export interface InstrumentSeedPlan {
  instrumentKey: string; // stable internal label — identity proof is shareClassFIGI
  instrumentName: string;
  shareClass: string | null;
  instrumentType: string;
  issuerCik: string; // 10-digit, for provenance metadata
  currency: string | null;
  cfi: string | null;
  /** share_class_figi once (global share-class identity) + every distinct
   *  composite_figi (country/market-level — one per market, per OpenFIGI
   *  hierarchy), each tagged with the venue MICs that reported it. */
  instrumentIdentifiers: {
    scheme: string;
    value: string;
    scope: string;
    metadata?: Record<string, unknown>;
  }[];
  listings: ListingSeedPlan[];
}

/** instrument_type → key slug — the key encodes the REAL type,
 *  not a hardcoded 'common_stock'. */
const TYPE_KEY_SLUG: Readonly<Record<string, string>> = {
  common_stock: "common_stock",
  preferred_stock: "preferred_stock",
  depositary_receipt: "adr",
  bond: "bond",
  note: "note",
  etf: "etf",
  fund: "fund",
  index: "index",
  future: "future",
  option: "option",
  other: "other",
};

/** Type-aware key descriptor.
 *   ('ALPHABET INC-CL A', 'common_stock')      → 'class_a_common_stock'
 *   ('ALPHABET INC-CL A', 'depositary_receipt') → 'class_a_adr'
 *   ('ACME CORP PFD SER A', 'preferred_stock')  → 'series_a_preferred_stock'
 *   ('MICROSOFT CORP', 'common_stock')          → 'common_stock'
 *  Returns [descriptor, shareClass]. */
export function instrumentDescriptor(
  name: string,
  instrumentType: string,
): [string, string | null] {
  const typeSlug = TYPE_KEY_SLUG[instrumentType] ?? "other";
  const m =
    /(?:\bCL(?:ASS)?|\bSHS?|\bSER(?:IES)?|\bPFD)[ -]*(?:CL[ -]*)?([A-Z])\b/i.exec(
      name,
    );
  if (m) {
    const cls = m[1].toUpperCase();
    // preferred shares conventionally use 'series'; equity/ADR use 'class'
    const prefix = instrumentType === "preferred_stock" ? "series" : "class";
    return [`${prefix}_${cls.toLowerCase()}_${typeSlug}`, cls];
  }
  return [typeSlug, null];
}

/**
 * Derive one instrument + its venue listings from corroborating providers.
 * One listing per MIC that returned a matching ticker result (multi-venue
 * is real). Conservative: provider disagreement → conflict, nothing promoted.
 */
export function deriveSeed(
  input: SeedInput,
): SeedOutcome | { kind: "plan"; plan: InstrumentSeedPlan } {
  const { secRow, venues, issuerSlug } = input;
  if (!venues.length)
    return {
      kind: "unresolved",
      reason: `unmapped_exchange:${secRow.exchange}`,
    };

  const listings: ListingSeedPlan[] = [];
  const composites = new Map<string, Set<string>>(); // compositeFigi → mics
  let shareClassFigi: string | undefined;
  let name: string | undefined;
  let currency: string | null = null;
  let type: string | null = null;
  let cfi: string | undefined;

  for (const { mic, obsId, results } of venues) {
    if (!results.length) continue;
    const matching = results.filter(
      (r) =>
        (r.ticker ?? "").toUpperCase() === secRow.ticker.toUpperCase() &&
        r.figi,
    );
    if (!matching.length)
      return { kind: "conflict", reason: `openfigi_ticker_mismatch:${mic}` };
    const figis = new Set(matching.map((r) => r.figi));
    if (figis.size > 1)
      return {
        kind: "conflict",
        reason: `openfigi_ambiguous:${figis.size}_candidates@${mic}`,
      };
    const r = matching[0];
    const t = figiInstrumentType(r);
    if (!t)
      return {
        kind: "unresolved",
        reason: `unsupported_security_type:${r.securityType2 ?? r.securityType ?? "?"}`,
      };
    if (!r.shareClassFIGI || !r.compositeFIGI)
      return {
        kind: "unresolved",
        reason: "openfigi_missing_share_class_figi",
      };
    // every venue line must agree on share-class identity + instrument type;
    // compositeFIGI may differ per market — collected, never collapsed
    if (shareClassFigi && shareClassFigi !== r.shareClassFIGI)
      return {
        kind: "conflict",
        reason: "share_class_figi_mismatch_across_venues",
      };
    if (type && type !== t)
      return {
        kind: "conflict",
        reason: `instrument_type_mismatch:${type}!=${t}@${mic}`,
      };
    shareClassFigi = r.shareClassFIGI;
    name ??= r.name ?? secRow.name;
    currency ??= r.currency ?? null;
    type ??= t;
    cfi ??= r.cfi;
    const mics = composites.get(r.compositeFIGI) ?? new Set<string>();
    mics.add(mic);
    composites.set(r.compositeFIGI, mics);
    listings.push({
      listingKey: "", // filled after instrumentKey is known
      mic,
      ticker: secRow.ticker,
      currency: r.currency ?? null,
      figi: r.figi!,
      obsId,
    });
  }
  if (!listings.length)
    return { kind: "unresolved", reason: "openfigi_no_result" };

  const [desc, shareClass] = instrumentDescriptor(name ?? secRow.name, type!);
  const instrumentKey = `instrument:${issuerSlug}:${desc}`;
  for (const l of listings)
    l.listingKey = `listing:${issuerSlug}:${desc}:${l.mic.toLowerCase()}`;
  return {
    kind: "plan",
    plan: {
      instrumentKey,
      instrumentName: name ?? secRow.name,
      shareClass,
      instrumentType: type!,
      issuerCik: String(secRow.cik).padStart(10, "0"),
      currency,
      cfi: cfi ?? null,
      instrumentIdentifiers: [
        { scheme: "share_class_figi", value: shareClassFigi!, scope: "global" },
        ...[...composites.entries()].map(([value, mics]) => ({
          scheme: "composite_figi",
          value,
          scope: "composite",
          metadata: { mics: [...mics] },
        })),
      ],
      listings,
    },
  };
}

// ── version-change detection (Phase 4) ────────────────────────────────────
// A new version is written only when semantic state changed — re-observing
// identical provider data must be a no-op. Comparison is NULL-safe and
// normalizes dates/timestamps so '2024-01-01' === Date('2024-01-01').

const norm = (v: unknown): string => {
  if (v == null || v === "") return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

function fieldsChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.some((f) => norm(cur[f]) !== norm(next[f]));
}

const INSTRUMENT_VERSION_FIELDS = [
  "name",
  "short_name",
  "asset_class",
  "instrument_type",
  "currency",
  "issue_date",
  "maturity_date",
  "share_class",
  "voting_class",
  "cfi",
  "status",
] as const;

export function instrumentVersionChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return fieldsChanged(cur, next, INSTRUMENT_VERSION_FIELDS);
}

const LISTING_VERSION_FIELDS = [
  "ticker",
  "currency",
  "status",
  "is_primary_listing",
] as const;

export function listingVersionChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return fieldsChanged(cur, next, LISTING_VERSION_FIELDS);
}

const VENUE_VERSION_FIELDS = [
  "market_name",
  "legal_entity_name",
  "lei",
  "country_code",
  "city",
  "operating_mic",
  "mic_role",
  "market_category",
  "acronym",
  "status",
] as const;

export function venueVersionChanged(
  cur: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return fieldsChanged(cur, next, VENUE_VERSION_FIELDS);
}
