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
  computePremiumBars,
  computeRatioBars,
  isoDay,
  parseBinanceKlines,
  parseBinanceP2P,
  parseErApiRate,
  parseFawazRates,
  parseGiavangHistory,
  parseVcbXml,
  type DailyBar,
  type PremiumLegs,
} from "../../lib/market.ts";
import {
  applyDailyBars,
  detectPremiumShift,
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

type AltProvider =
  "giavang" | "binance" | "er_api" | "vietcombank" | "fawaz" | "derived";

interface AltEntry {
  /** provider transport symbol — giavang code / binance pair / '-' for FX */
  code: string;
  instrumentSlug: string;
  type: "commodity" | "crypto" | "fx_pair" | "index";
  assetClass: "commodity" | "crypto" | "fx";
  venueMic: string;
  ticker: string;
  currency: "VND" | "USD" | null;
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
    // volume_spike detector — a crypto session ≥3× its 20-day median
    // volume is signal (equities/indexes/quote boards don't opt in)
    seriesMeta: { volumeSpikeMult: 3, volumeSpikeLookback: 20 },
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
  {
    // fawaz's dated tags carry real history — this series backfills the
    // official-mid leg the gold premium + FX gap are measured against
    code: "-",
    instrumentSlug: "usd_vnd",
    type: "fx_pair",
    assetClass: "fx",
    venueMic: "FAWAZ",
    ticker: "USDVND",
    currency: "VND",
    nameVi: "Tỷ giá USD/VND (tham chiếu)",
    nameEn: "USD/VND mid (fawaz)",
    issuerSlug: null,
    provider: "fawaz",
    dataset: "v1_daily",
    priceBasis: "quoted",
    materialMovePct: 0.5,
    highMovePct: 1,
  },
  {
    code: "USD",
    instrumentSlug: "usd_vnd",
    type: "fx_pair",
    assetClass: "fx",
    venueMic: "VCB",
    ticker: "USDVND",
    currency: "VND",
    nameVi: "USD/VND Vietcombank",
    nameEn: "USD/VND Vietcombank board",
    issuerSlug: null,
    provider: "vietcombank",
    dataset: "tygia",
    priceBasis: "quoted",
    materialMovePct: 0.5,
    highMovePct: 1,
    seriesMeta: { quote: "bid_ask", unit: "VND" },
  },
  {
    // Binance P2P — the de-facto free-market VND rate; USDT is the unit
    // VN actually trades USD exposure in, so this is its own instrument
    code: "USDT",
    instrumentSlug: "usdt_vnd",
    type: "fx_pair",
    assetClass: "fx",
    venueMic: "BINANCE_P2P",
    ticker: "USDTVND",
    currency: "VND",
    nameVi: "USDT/VND chợ tự do (P2P)",
    nameEn: "USDT/VND free market (Binance P2P)",
    issuerSlug: null,
    provider: "binance",
    dataset: "p2p",
    priceBasis: "quoted",
    materialMovePct: 0.5,
    highMovePct: 1,
    seriesMeta: { quote: "bid_ask", unit: "VND" },
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
  {
    mic: "FAWAZ",
    name: "fawaz currency-api (jsDelivr)",
    city: "",
    country: "",
    kind: "reference_rate",
  },
  {
    mic: "VCB",
    name: "Vietcombank rate board",
    city: "Hanoi",
    country: "VN",
    kind: "price_board",
  },
  {
    mic: "BINANCE_P2P",
    name: "Binance P2P VN board",
    city: "",
    country: "",
    kind: "free_market",
  },
  {
    mic: "DERIVED",
    name: "computed from other series",
    city: "",
    country: "",
    kind: "derived",
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
  } else if (e.provider === "binance" && e.dataset === "p2p") {
    // both ad sides → the free-market bid/ask pair for today
    url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
    const side = async (tradeType: "BUY" | "SELL") =>
      (await (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fiat: "VND",
            page: 1,
            rows: 10,
            tradeType,
            asset: "USDT",
          }),
        })
      ).json()) as unknown;
    const buyAds = await side("BUY"); // makers selling USDT → taker's ask
    const sellAds = await side("SELL"); // makers buying → taker's bid
    payload = { buy: buyAds, sell: sellAds };
    const ask = parseBinanceP2P(buyAds);
    const bid = parseBinanceP2P(sellAds);
    if (ask.kind !== "price" || bid.kind !== "price")
      throw new Error(`USDT P2P: ${ask.detail ?? bid.detail ?? "no quotes"}`);
    const b = String(bid.price);
    const a = String(ask.price);
    parsed = {
      kind: "series",
      bars: [
        {
          sessionDate: today,
          open: b,
          high: a,
          low: b,
          close: a,
          volume: null,
        },
      ],
    };
  } else if (e.provider === "binance") {
    url = `https://api.binance.com/api/v3/klines?symbol=${e.code}&interval=1d&limit=120`;
    payload = await (await fetch(url)).json();
    parsed = parseBinanceKlines(payload);
  } else if (e.provider === "vietcombank") {
    url =
      "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx";
    payload = { xml: await (await fetch(url)).text() };
    parsed = parseVcbXml((payload as { xml: string }).xml, {
      currency: e.code,
    });
  } else if (e.provider === "fawaz") {
    // one dated tag per session — the tag IS the history snapshot
    const days: Record<string, unknown> = {};
    const bars: DailyBar[] = [];
    for (let back = 30; back >= 0; back--) {
      const d = isoDay(new Date(Date.now() - back * 86400e3));
      const u = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.json`;
      const day = (await (await fetch(u)).json()) as unknown;
      const r = parseFawazRates(day);
      if (r.kind === "series") {
        days[d] = day;
        bars.push(r.bars[0]);
      }
      // a missing/failed day just leaves a gap — never fabricate a rate
    }
    url =
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/usd.json";
    payload = { dates: days };
    parsed = bars.length
      ? { kind: "series", bars }
      : {
          kind: "provider_error",
          errorClass: "empty",
          detail: "no dated snapshots returned VND",
        };
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

// ── derived: SJC-vs-world premium ────────────────────────────────────────
// Runs after the base legs so today's premium reads fresh SJC/XAU/FX.
// The premium is a %-valued series of its own — its delta is
// premium_shift (absolute pp moves), so metadata.moveDelta=false keeps
// the relative market_move detector off.

const PREMIUM_ENTRY: AltEntry = {
  code: "-",
  instrumentSlug: "sjc_world_premium",
  type: "index",
  assetClass: "commodity",
  venueMic: "DERIVED",
  ticker: "SJC-PREM",
  currency: null,
  nameVi: "Chênh lệch SJC − thế giới",
  nameEn: "SJC vs world premium",
  issuerSlug: null,
  provider: "derived",
  dataset: "sjc_premium_daily",
  priceBasis: "quoted",
  materialMovePct: 0, // unused — moveDelta off
  highMovePct: 0,
  seriesMeta: {
    unit: "pct",
    derived: true,
    moveDelta: false,
    legs: ["vang_sjc_9999", "xau_usd_spot", "usd_vnd"],
  },
};

/** Per-date {open,close} of every series on a listing, keyed by date.
 *  Multiple providers on one listing collapse into one map — callers that
 *  need provider choice merge candidate listings in preference order. */
async function fetchLegRows(
  db: NonNullable<typeof c>,
  listingKey: string,
): Promise<Map<string, { open: number; close: number }>> {
  const { rows } = await db.query(
    `SELECT mp.session_date, mv.open, mv.close
       FROM market_points mp
       JOIN market_point_versions mv ON mv.id = mp.current_version_id
       JOIN market_series ms ON ms.id = mp.series_id
       JOIN instrument_listings il ON il.id = ms.listing_id
      WHERE il.canonical_key = $1
      ORDER BY mp.session_date`,
    [listingKey],
  );
  const out = new Map<string, { open: number; close: number }>();
  for (const r of rows) {
    const d = isoDay(r.session_date);
    if (!out.has(d))
      out.set(d, { open: Number(r.open), close: Number(r.close) });
  }
  return out;
}

/** First candidate wins per date — the preference order IS the leg's
 *  provenance rule (e.g. fawaz depth over er_api recency). */
function mergeLegs<T>(cands: Map<string, T>[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const m of cands) for (const [d, v] of m) if (!out.has(d)) out.set(d, v);
  return out;
}

/** Official-mid USD/VND: fawaz carries history, er_api is the fallback. */
const FX_LEG_KEYS = [
  "listing:usd_vnd:fx_pair:fawaz",
  "listing:usd_vnd:fx_pair:erfx",
] as const;

if (!DRY_RUN && c) {
  const [sjcMap, xauMap, p2pMap, ...fxCands] = await Promise.all([
    fetchLegRows(c, "listing:vang_sjc_9999:commodity:goldvn"),
    fetchLegRows(c, "listing:xau_usd_spot:commodity:xauotc"),
    fetchLegRows(c, "listing:usdt_vnd:fx_pair:binance_p2p"),
    ...FX_LEG_KEYS.map((k) => fetchLegRows(c, k)),
  ]);
  const fxMap = mergeLegs(fxCands);

  // ── SJC-vs-world premium ───────────────────────────────────────────
  const { listingId, listingKey } = await ensureListing(
    PREMIUM_ENTRY,
    universeObsId,
  );
  const legs = new Map<string, PremiumLegs>();
  for (const [d, s] of sjcMap) {
    const x = xauMap.get(d);
    const f = fxMap.get(d);
    if (x && f)
      legs.set(d, { sjcSell: s.close, xauUsd: x.close, usdVnd: f.close });
  }
  const bars = computePremiumBars(legs);
  const obsId = await observe(c, {
    provider: "derived",
    dataset: PREMIUM_ENTRY.dataset,
    recordKey: `premium/${today}`,
    payload: {
      formula: "sjc_sell / (xau_usd × usd_vnd × 1.205653) − 1",
      legs: Object.fromEntries(legs),
      fxLegPreference: [...FX_LEG_KEYS],
    },
  });
  const seriesId = await getOrCreateMarketSeries(c, {
    listingId,
    listingKey,
    provider: PREMIUM_ENTRY.provider,
    dataset: PREMIUM_ENTRY.dataset,
    priceBasis: PREMIUM_ENTRY.priceBasis,
  });
  await c.query(
    `UPDATE market_series SET metadata = metadata || $2::jsonb WHERE id=$1`,
    [seriesId, JSON.stringify(PREMIUM_ENTRY.seriesMeta)],
  );
  const pr = await applyDailyBars(c, seriesId, bars, obsId);
  const shift = await detectPremiumShift(c, seriesId);
  console.log(
    `SJC-PREM: ${bars.length} bars +${pr.pointsInserted}pts` +
      (shift.shifted ? ` premium_shift ${shift.deltaPp!.toFixed(2)}pt` : ""),
  );

  // ── free-market gap: Binance P2P mid vs official mid ────────────────
  // The classic VN "spread chợ tự do" — a %-valued derived series like
  // the gold premium, tracked by the same premium_shift detector but at
  // a tighter threshold (the gap lives in tenths of a percent).
  const GAP_ENTRY: AltEntry = {
    code: "-",
    instrumentSlug: "usdt_vnd_gap",
    type: "index",
    assetClass: "fx",
    venueMic: "DERIVED",
    ticker: "USDT-GAP",
    currency: null,
    nameVi: "Chênh USDT tự do − tỷ giá chính thức",
    nameEn: "Free-market vs official VND gap",
    issuerSlug: null,
    provider: "derived",
    dataset: "usdt_vnd_gap_daily",
    priceBasis: "quoted",
    materialMovePct: 0,
    highMovePct: 0,
    seriesMeta: {
      // par-100 index — the gap oscillates around zero, and a signed %
      // can never be stored under the OHLC validity CHECK; close−100
      // reads the signed % gap, index diffs equal pp diffs
      unit: "index_par100",
      derived: true,
      moveDelta: false,
      legs: ["usdt_vnd", "usd_vnd"],
    },
  };
  const gapListing = await ensureListing(GAP_ENTRY, universeObsId);
  const gapLegs = new Map<string, { num: number; den: number }>();
  for (const [d, p] of p2pMap) {
    const f = fxMap.get(d);
    if (f) gapLegs.set(d, { num: (p.open + p.close) / 2, den: f.close });
  }
  const gapBars = computeRatioBars(gapLegs);
  const gapObsId = await observe(c, {
    provider: "derived",
    dataset: GAP_ENTRY.dataset,
    recordKey: `gap/${today}`,
    payload: {
      formula: "100 × usdt_vnd_mid / official_usdvnd  (par-100 index)",
      legs: Object.fromEntries(gapLegs),
      fxLegPreference: [...FX_LEG_KEYS],
    },
  });
  const gapSeriesId = await getOrCreateMarketSeries(c, {
    listingId: gapListing.listingId,
    listingKey: gapListing.listingKey,
    provider: GAP_ENTRY.provider,
    dataset: GAP_ENTRY.dataset,
    priceBasis: GAP_ENTRY.priceBasis,
  });
  await c.query(
    `UPDATE market_series SET metadata = metadata || $2::jsonb WHERE id=$1`,
    [gapSeriesId, JSON.stringify(GAP_ENTRY.seriesMeta)],
  );
  const gr = await applyDailyBars(c, gapSeriesId, gapBars, gapObsId);
  // gap moves in tenths of a percent — tighter band than the gold premium
  const gshift = await detectPremiumShift(c, gapSeriesId, Date.now(), {
    mediumPp: 0.3,
    highPp: 0.75,
  });
  console.log(
    `USDT-GAP: ${gapBars.length} bars +${gr.pointsInserted}pts` +
      (gshift.shifted ? ` premium_shift ${gshift.deltaPp!.toFixed(2)}pt` : ""),
  );
} else {
  console.log("[dry] premium leg skipped — needs DB");
}

console.log(
  `done: ${summary.imported} imported, ${summary.errors.length} errors`,
);
for (const e of summary.errors) console.log(`  ! ${e}`);
if (!DRY_RUN) await c.end();
process.exit(summary.errors.length ? 1 : 0);
