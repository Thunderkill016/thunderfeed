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
  instrumentKey: string; // 'instrument:alphabet:class_a_common_stock'
  instrumentName: string;
  shareClass: string | null;
  instrumentType: string;
  issuerCik: string; // 10-digit, for provenance metadata
  currency: string | null;
  instrumentIdentifiers: { scheme: string; value: string; scope: string }[];
  listings: ListingSeedPlan[];
}

/** 'ALPHABET INC-CL A' → 'class_a'; 'MICROSOFT CORP' → 'common_stock'.
 *  Returns [keyDescriptor, shareClass]. */
export function classDescriptor(name: string): [string, string | null] {
  const m = /(?:\bCL(?:ASS)?|\bSHS?)[ -]*(?:CL[ -]*)?([A-Z])\b/i.exec(name);
  if (m)
    return [`class_${m[1].toLowerCase()}_common_stock`, m[1].toUpperCase()];
  return ["common_stock", null];
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
  let shareClassFigi: string | undefined;
  let compositeFigi: string | undefined;
  let name: string | undefined;
  let currency: string | null = null;
  let type: string | null = null;
  const seenShareClass = new Set<string>();

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
    shareClassFigi ??= r.shareClassFIGI;
    compositeFigi ??= r.compositeFIGI;
    name ??= r.name ?? secRow.name;
    currency ??= r.currency ?? null;
    type ??= t;
    seenShareClass.add(r.shareClassFIGI);
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
  // every venue line of one instrument must agree on the share class —
  // disagreement means our ticker→instrument grouping is wrong
  if (seenShareClass.size > 1)
    return {
      kind: "conflict",
      reason: "share_class_figi_mismatch_across_venues",
    };

  const [desc, shareClass] = classDescriptor(name ?? secRow.name);
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
      instrumentIdentifiers: [
        { scheme: "share_class_figi", value: shareClassFigi!, scope: "global" },
        { scheme: "composite_figi", value: compositeFigi!, scope: "composite" },
      ],
      listings,
    },
  };
}
