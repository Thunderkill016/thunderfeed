/* Alt-asset importer — the pivot's non-equity universe.
 *
 *   npx tsx scripts/market/import-altassets.mts
 *     [--listing <key-or-code>] [--limit N] [--dry-run]
 *
 * Coverage (per product decision: stocks+BĐS stay VN-only; gold and crypto
 * carry world + domestic legs — VN investors actually trade these):
 *
 *   GOLD   giavang.now public API — VN retail boards (SJC 9999, SJC nhẫn,
 *          DOJI, PNJ HN, Bảo Tín) + world spot XAU/USD. Quote boards give a
 *          bid/ask pair → series price_basis 'quoted', open=low=buy,
 *          high=close=sell (lossless pair, documented in series metadata).
 *   CRYPTO Binance public klines — real OHLCV, 'as_traded'.
 *   FX     open.er-api.com — USD/VND mid-market reference. Point rate → all
 *          four bar fields equal; 'quoted' basis.
 *
 * Pseudo-venues: GOLDVN / XAUOTC / BINANCE / ERFX are NOT ISO 10383 MICs —
 * they name the price source honestly instead of pretending to be
 * exchanges. venue metadata carries venue_kind:'price_board'|'exchange'|
 * 'reference_rate'.
 *
 * market_move thresholds live in series metadata: gold 1.5% (tight board),
 * crypto 8% (±5% is routine), FX 0.5% (SBV ±5% band around central rate).
 */
import { readFileSync } from "node:fs";
import {
  parseBinanceKlines,
  parseErApiRate,
  parseGiavangHistory,
  type DailyBar,
} from "../../lib/market.ts";
import {
  applyDailyBars,
  getOrCreateMarketSeries,
} from "../../lib/db/market.ts";
import { recordDerivation } from "../../lib/db/instruments.ts";
import { connectDb, observe } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

type AltProvider = "giavang" | "binance" | "er_api";

interface AltEntry {
  /** provider transport symbol — giavang code / binance pair / '-' for FX */
  code: string;
  instrumentSlug: string;
  type: "commodity" | "crypto" | "fx_pair";
  assetClass: "commodity" | "crypto" | "fx";
  venueMic: string;
  ticker: string;
  currency: "VND" | "USD";
  nameVi: string;
  nameEn: string;
  /** issuer entity slug — null for spot assets with no issuer */
  issuerSlug: string | null;
  issuerVi?: string;
  issuerEn?: string;
  issuerAliases?: string[];
  provider: AltProvider;
  dataset: string;
  priceBasis: "quoted" | "as_traded";
  /** series-level market_move policy */
  materialMovePct: number;
  highMovePct: number;
  seriesMeta?: Record<string, unknown>;
}

const ALT_UNIVERSE: AltEntry[] = [
  // ── VN gold retail boards (giavang codes) ─────────────────────────────
  {
    code: "SJL1L10",
    instrumentSlug: "vang_sjc_9999",
    type: "commodity",
    assetClass: "commodity",
    venueMic: "GOLDVN",
    ticker: "SJC9999",
    currency: "VND",
    nameVi: "Vàng SJC 9999 (lượng)",
    nameEn: "SJC 9999 gold bar",
    issuerSlug: "sjc",
    issuerVi: "Công ty Vàng bạc Đá quý Sài Gòn",
    issuerEn: "Saigon Jewelry Company",
    issuerAliases: ["SJC", "Sài Gòn Jewelry"],
    provider: "giavang",
    dataset: "gold_board_daily",
    priceBasis: "quoted",
    materialMovePct: 1.5,
    highMovePct: 3,
    seriesMeta: { quote: "bid_ask", unit: "VND/lượng" },
  },
  {
    code: "DOJINHTV",
    instrumentSlug: "vang_doji",
    type: "commodity",
    assetClass: "commodity",
    venueMic: "GOLDVN",
    ticker: "DOJI",
    currency: "VND",
    nameVi: "Vàng DOJI (lượng)",
    nameEn: "DOJI gold",
    issuerSlug: "doji",
    issuerVi: "Tập đoàn Vàng bạc Đá quý DOJI",
    issuerEn: "DOJI Gold & Gems Group",
    issuerAliases: ["DOJI"],
    provider: "giavang",
    dataset: "gold_board_daily",
    priceBasis: "quoted",
    materialMovePct: 1.5,
    highMovePct: 3,
    seriesMeta: { quote: "bid_ask", unit: "VND/lượng" },
  },
  {
    code: "PQHNVM",
    instrumentSlug: "vang_pnj",
    type: "commodity",
    assetClass: "commodity",
    venueMic: "GOLDVN",
    ticker: "PNJ-GOLD",
    currency: "VND",
    nameVi: "Vàng PNJ (lượng)",
    nameEn: "PNJ gold",
    issuerSlug: "pnj",
    issuerVi: "Công ty Cổ phần Vàng bạc Đá quý Phú Nhuận",
    issuerEn: "Phu Nhuan Jewelry JSC",
    issuerAliases: ["PNJ"],
    provider: "giavang",
    dataset: "gold_board_daily",
    priceBasis: "quoted",
    materialMovePct: 1.5,
    highMovePct: 3,
    seriesMeta: { quote: "bid_ask", unit: "VND/lượng" },
  },
  {
    code: "BT9999NTT",
    instrumentSlug: "vang_baotin",
    type: "commodity",
    assetClass: "commodity",
    venueMic: "GOLDVN",
    ticker: "BTMC",
    currency: "VND",
    nameVi: "Vàng Bảo Tín Minh Châu (lượng)",
    nameEn: "Bao Tin Minh Chau gold",
    issuerSlug: "bao_tin_minh_chau",
    issuerVi: "Công ty Vàng bạc Đá quý Bảo Tín Minh Châu",
    issuerEn: "Bao Tin Minh Chau JSC",
    issuerAliases: ["Bảo Tín", "BTMC"],
    provider: "giavang",
    dataset: "gold_board_daily",
    priceBasis: "quoted",
    materialMovePct: 1.5,
    highMovePct: 3,
    seriesMeta: { quote: "bid_ask", unit: "VND/lượng" },
  },
  // ── World spot gold — the leg the SJC premium is measured against ──────
  {
    code: "XAUUSD",
    instrumentSlug: "xau_usd_spot",
    type: "commodity",
    assetClass: "commodity",
    venueMic: "XAUOTC",
    ticker: "XAUUSD",
    currency: "USD",
    nameVi: "Vàng thế giới (XAU/USD)",
    nameEn: "World spot gold",
    issuerSlug: null,
    provider: "giavang",
    dataset: "gold_spot_daily",
    priceBasis: "quoted",
    materialMovePct: 1.5,
    highMovePct: 3,
    seriesMeta: { quote: "single", unit: "USD/troy_oz" },
  },
  // ── Crypto majors (Binance spot) ───────────────────────────────────────
  ...(["BTC", "ETH", "SOL", "BNB"] as const).map((sym) => ({
    code: `${sym}USDT`,
    instrumentSlug: {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      BNB: "bnb",
    }[sym],
    type: "crypto" as const,
    assetClass: "crypto" as const,
    venueMic: "BINANCE",
    ticker: `${sym}USDT`,
    currency: "USD" as const,
    nameVi: `${sym} / USDT`,
    nameEn: `${{ BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB" }[sym]} spot`,
    issuerSlug: null,
    provider: "binance" as const,
    dataset: "klines_1d",
    priceBasis: "as_traded" as const,
    materialMovePct: 8,
    highMovePct: 15,
  })),
  // ── FX reference — USD/VND mid-market ──────────────────────────────────
  {
    code: "-",
    instrumentSlug: "usd_vnd",
    type: "fx_pair",
    assetClass: "fx",
    venueMic: "ERFX",
    ticker: "USDVND",
    currency: "VND",
    nameVi: "Tỷ giá USD/VND",
    nameEn: "USD/VND reference rate",
    issuerSlug: null,
    provider: "er_api",
    dataset: "reference_rate_daily",
    priceBasis: "quoted",
    materialMovePct: 0.5,
    highMovePct: 1,
  },
];

/** pseudo-venues — NOT ISO MICs; name the actual price source. */
const VENUES: {
  mic: string;
  name: string;
  city: string;
  country: string;
  kind: string;
}[] = [
  {
    mic: "GOLDVN",
    name: "VN retail gold price boards",
    city: "Hanoi",
    country: "VN",
    kind: "price_board",
  },
  {
    mic: "XAUOTC",
    name: "OTC spot gold (world)",
    city: "London",
    country: "GB",
    kind: "otc",
  },
  {
    mic: "BINANCE",
    name: "Binance spot",
    city: "",
    country: "",
    kind: "exchange",
  },
  {
    mic: "ERFX",
    name: "open.er-api reference FX",
    city: "",
    country: "",
    kind: "reference_rate",
  },
];

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const ONLY = opt("listing");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;
const today = new Date().toISOString().slice(0, 10);

// dry-run = parser/API check only — never connect
const c = connectDb();
if (!DRY_RUN) await c.connect();

async function ensureEntity(
  slug: string,
  type: "company" | "organization" | "commodity",
  nameVi: string,
  nameEn: string,
  aliases: string[],
  country = "VN",
): Promise<string> {
  const key = `${type}:${slug}`;
  const ins = await c.query(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type, status, country_code)
     VALUES ($1,$2,$3,'active',$4)
     ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
    [key, nameVi, type, country || null],
  );
  const id =
    ins.rows[0]?.id ??
    (await c.query(`SELECT id FROM entities WHERE canonical_key=$1`, [key]))
      .rows[0].id;
  for (const a of new Set([nameVi, nameEn, ...aliases])) {
    await c.query(
      `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, alias_type)
       VALUES ($1,$2,lower($2),'common_name') ON CONFLICT DO NOTHING`,
      [id, a],
    );
  }
  return id as string;
}

async function ensureVenue(mic: string, obsId: string): Promise<string> {
  const v = VENUES.find((x) => x.mic === mic);
  if (!v) throw new Error(`venue ${mic} not declared`);
  const ins = await c.query(
    `INSERT INTO trading_venues (mic) VALUES ($1)
     ON CONFLICT (mic) DO NOTHING RETURNING id`,
    [mic],
  );
  const id =
    ins.rows[0]?.id ??
    (await c.query(`SELECT id FROM trading_venues WHERE mic=$1`, [mic])).rows[0]
      .id;
  const cur = await c.query(
    `SELECT vv.* FROM trading_venues t
       JOIN trading_venue_versions vv ON vv.id = t.current_version_id
      WHERE t.id=$1`,
    [id],
  );
  if (!cur.rows.length || cur.rows[0].market_name !== v.name) {
    const nv = await c.query(
      `INSERT INTO trading_venue_versions
         (venue_id, version_no, market_name, country_code, city,
          operating_mic, mic_role, status, observation_id,
          previous_version_id, metadata)
       VALUES ($1,$2,$3,$4,$5,NULL,'operating','active',$6,$7,$8)
       RETURNING id`,
      [
        id,
        ((cur.rows[0]?.version_no as number) ?? 0) + 1,
        v.name,
        v.country || null,
        v.city || null,
        obsId,
        cur.rows[0]?.id ?? null,
        JSON.stringify({ venue_kind: v.kind, iso_mic: false }),
      ],
    );
    await c.query(
      `UPDATE trading_venues SET current_version_id=$1 WHERE id=$2`,
      [nv.rows[0].id, id],
    );
  }
  return id as string;
}

async function ensureListing(
  e: AltEntry,
  obsId: string,
): Promise<{ listingId: string; listingKey: string }> {
  const issuerId = e.issuerSlug
    ? await ensureEntity(
        e.issuerSlug,
        "company",
        e.issuerVi ?? e.nameVi,
        e.issuerEn ?? e.nameEn,
        e.issuerAliases ?? [],
      )
    : null;
  const instrumentKey = `instrument:${e.instrumentSlug}:${e.type}`;
  const ins = await c.query(
    `INSERT INTO financial_instruments
       (canonical_key, issuer_entity_id, instrument_type)
     VALUES ($1,$2,$3) ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
    [instrumentKey, issuerId, e.type],
  );
  const instrumentId =
    ins.rows[0]?.id ??
    (
      await c.query(
        `SELECT id FROM financial_instruments WHERE canonical_key=$1`,
        [instrumentKey],
      )
    ).rows[0].id;
  await recordDerivation(
    c,
    { type: "instrument", id: instrumentId },
    obsId,
    "asserts",
  );

  const curV = await c.query(
    `SELECT iv.* FROM financial_instruments fi
       JOIN instrument_versions iv ON iv.id = fi.current_version_id
     WHERE fi.id=$1`,
    [instrumentId],
  );
  const changed =
    !curV.rows.length ||
    ["name", "asset_class", "instrument_type", "currency"].some(
      (k) =>
        String((curV.rows[0] as Record<string, unknown>)[k] ?? "") !==
        String(
          {
            name: e.nameEn,
            asset_class: e.assetClass,
            instrument_type: e.type,
            currency: e.currency,
          }[k as never] ?? "",
        ),
    );
  if (changed) {
    const nv = await c.query(
      `INSERT INTO instrument_versions
         (instrument_id, version_no, name, asset_class, instrument_type,
          currency, observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        instrumentId,
        ((curV.rows[0]?.version_no as number) ?? 0) + 1,
        e.nameEn,
        e.assetClass,
        e.type,
        e.currency,
        obsId,
        curV.rows[0]?.id ?? null,
      ],
    );
    await c.query(
      `UPDATE financial_instruments SET current_version_id=$1 WHERE id=$2`,
      [nv.rows[0].id, instrumentId],
    );
    await recordDerivation(
      c,
      { type: "instrument_version", id: nv.rows[0].id },
      obsId,
      "asserts",
    );
  }

  const listingKey = `listing:${e.instrumentSlug}:${e.type}:${e.venueMic.toLowerCase()}`;
  const venueId = await ensureVenue(e.venueMic, obsId);
  const lins = await c.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ($1,$2,$3) ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
    [listingKey, instrumentId, venueId],
  );
  const listingId =
    lins.rows[0]?.id ??
    (
      await c.query(
        `SELECT id FROM instrument_listings WHERE canonical_key=$1`,
        [listingKey],
      )
    ).rows[0].id;
  await recordDerivation(
    c,
    { type: "listing", id: listingId },
    obsId,
    "asserts",
  );

  const curL = await c.query(
    `SELECT lv.* FROM instrument_listings l
       JOIN listing_versions lv ON lv.id = l.current_version_id
     WHERE l.id=$1`,
    [listingId],
  );
  if (!curL.rows.length || curL.rows[0].ticker !== e.ticker) {
    const lv = await c.query(
      `INSERT INTO listing_versions
         (listing_id, version_no, ticker, currency, is_primary_listing,
          observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
      [
        listingId,
        ((curL.rows[0]?.version_no as number) ?? 0) + 1,
        e.ticker,
        e.currency,
        obsId,
        curL.rows[0]?.id ?? null,
      ],
    );
    await c.query(
      `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
      [lv.rows[0].id, listingId],
    );
    await recordDerivation(
      c,
      { type: "listing_version", id: lv.rows[0].id },
      obsId,
      "asserts",
    );
  }
  return { listingId, listingKey };
}

async function fetchBars(
  e: AltEntry,
): Promise<{ bars: DailyBar[]; url: string; payload: unknown }> {
  let url = "";
  let payload: unknown;
  let parsed: {
    kind: string;
    bars?: DailyBar[];
    detail?: string;
    errorClass?: string;
  };
  if (e.provider === "giavang") {
    url = `https://giavang.now/api/prices?type=${e.code}&days=30`;
    payload = await (await fetch(url)).json();
    parsed = parseGiavangHistory(payload, { code: e.code });
  } else if (e.provider === "binance") {
    url = `https://api.binance.com/api/v3/klines?symbol=${e.code}&interval=1d&limit=120`;
    payload = await (await fetch(url)).json();
    parsed = parseBinanceKlines(payload);
  } else {
    url = `https://open.er-api.com/v6/latest/USD`;
    payload = await (await fetch(url)).json();
    parsed = parseErApiRate(payload, { quote: "VND" });
  }
  if (parsed.kind !== "series")
    throw new Error(`${e.code}: ${parsed.errorClass} ${parsed.detail}`);
  return { bars: parsed.bars as DailyBar[], url, payload };
}

const summary = { seeded: 0, imported: 0, errors: [] as string[] };

const universeObsId = DRY_RUN
  ? "dry"
  : await observe(c, {
      provider: "manual_verified",
      dataset: "alt_asset_universe",
      recordKey: "v1",
      payload: {
        assertedAt: today,
        venues: VENUES,
        entries: ALT_UNIVERSE.map((e) => ({
          code: e.code,
          instrumentSlug: e.instrumentSlug,
          type: e.type,
          venue: e.venueMic,
          ticker: e.ticker,
          provider: e.provider,
        })),
      },
    });

const targets: { listingId: string; listingKey: string; entry: AltEntry }[] =
  [];
for (const e of ALT_UNIVERSE) {
  if (
    ONLY &&
    !e.instrumentSlug.includes(ONLY) &&
    !e.code.includes(ONLY.toUpperCase())
  )
    continue;
  if (DRY_RUN) {
    targets.push({
      listingId: "dry",
      listingKey: `listing:${e.instrumentSlug}:${e.type}:${e.venueMic.toLowerCase()}`,
      entry: e,
    });
    continue;
  }
  const { listingId, listingKey } = await ensureListing(e, universeObsId);
  targets.push({ listingId, listingKey, entry: e });
  summary.seeded++;
}
console.log(`seeded ${summary.seeded} alt listings`);

for (const { listingId, listingKey, entry } of LIMIT
  ? targets.slice(0, LIMIT)
  : targets) {
  try {
    const { bars, url, payload } = await fetchBars(entry);
    if (DRY_RUN) {
      console.log(
        `[dry] ${entry.code}: ${bars.length} bars ${bars[0]?.sessionDate}→${bars.at(-1)?.sessionDate}`,
      );
      continue;
    }
    const obsId = await observe(c, {
      provider: entry.provider,
      dataset: entry.dataset,
      recordKey: `${entry.code}/${today}`,
      sourceUrl: url,
      payload,
    });
    const seriesId = await getOrCreateMarketSeries(c, {
      listingId,
      listingKey,
      provider: entry.provider,
      dataset: entry.dataset,
      priceBasis: entry.priceBasis,
    });
    // series-level materiality policy — stored, not call-site opinion
    await c.query(
      `UPDATE market_series SET metadata = metadata || $2::jsonb WHERE id=$1`,
      [
        seriesId,
        JSON.stringify({
          materialMovePct: entry.materialMovePct,
          highMovePct: entry.highMovePct,
          ...(entry.seriesMeta ?? {}),
        }),
      ],
    );
    const r = await applyDailyBars(c, seriesId, bars, obsId);
    summary.imported++;
    console.log(
      `${entry.code}: +${r.pointsInserted}pts +${r.versionsInserted}v` +
        (r.deltas ? ` +${r.deltas}Δ` : "") +
        (r.invalid.length ? ` INVALID:${r.invalid.length}` : ""),
    );
  } catch (e) {
    summary.errors.push(`${entry.code}: ${(e as Error).message}`);
  }
}

console.log(
  `done: ${summary.imported} imported, ${summary.errors.length} errors`,
);
for (const e of summary.errors) console.log(`  ! ${e}`);
if (!DRY_RUN) await c.end();
process.exit(summary.errors.length ? 1 : 0);
