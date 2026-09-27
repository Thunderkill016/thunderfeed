/* VNDirect dchart importer — Vietnam coverage V1.
 *
 *   npx tsx scripts/market/import-vndirect.mts
 *     [--listing <canonical_key>] [--limit N]
 *     [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--dry-run]
 *
 * Two jobs:
 *   1. seed the VN listing universe — entities, instruments, listings,
 *      listing_versions, local_security_code identifiers — asserted by
 *      ONE manual_verified observation (the static map below). HOSE only
 *      (XSTC); HNX/UPCOM land when a provider covers them.
 *   2. fetch dchart/history per ticker → vndirect reference_observation
 *      → as_traded market series. Equity prices arrive in thousand-VND;
 *      priceScale=3 converts to canonical VND, indices scale 0.
 *
 * Identity is canonical keys (listing:<slug>:<type>:xstc), never tickers —
 * same invariant as US coverage.
 */
import { readFileSync } from "node:fs";
import {
  parseVndirectHistory,
  resolveVndirectSymbol,
} from "../../lib/market.ts";
import {
  applyDailyBars,
  getOrCreateVndirectSeries,
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

/* The asserted universe — ticker, issuer entity, names. Index rows carry
 * type 'index' and scale 0 (index points). Sources: HOSE listings +
 * company self-descriptions; asserted as manual_verified metadata. */
interface VnEntry {
  ticker: string; // VNDirect transport symbol
  slug: string; // issuer entity slug (company:<slug>)
  instrumentSlug: string; // instrument:<instrumentSlug>:<type>
  nameVi: string;
  nameEn: string;
  type: "common_stock" | "index";
  /** power-of-ten scale for provider prices → canonical VND (0 = points) */
  priceScale: number;
  aliases: string[];
}

const VN_UNIVERSE: VnEntry[] = [
  {
    ticker: "VNM",
    slug: "vinamilk",
    instrumentSlug: "vinamilk",
    nameVi: "Vinamilk",
    nameEn: "Vietnam Dairy Products",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Vinamilk", "VNM"],
  },
  {
    ticker: "FPT",
    slug: "fpt",
    instrumentSlug: "fpt",
    nameVi: "FPT",
    nameEn: "FPT Corporation",
    type: "common_stock",
    priceScale: 3,
    aliases: ["FPT", "Tập đoàn FPT"],
  },
  {
    ticker: "HPG",
    slug: "hoa_phat",
    instrumentSlug: "hoa_phat",
    nameVi: "Hòa Phát",
    nameEn: "Hoa Phat Group",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Hòa Phát", "HPG", "Hoa Phat"],
  },
  {
    ticker: "VCB",
    slug: "vietcombank",
    instrumentSlug: "vietcombank",
    nameVi: "Vietcombank",
    nameEn: "Joint Stock Commercial Bank for Foreign Trade of Vietnam",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Vietcombank", "VCB"],
  },
  {
    ticker: "VIC",
    slug: "vingroup",
    instrumentSlug: "vingroup",
    nameVi: "Vingroup",
    nameEn: "Vingroup JSC",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Vingroup", "VIC", "Tập đoàn Vingroup"],
  },
  {
    ticker: "VHM",
    slug: "vinhomes",
    instrumentSlug: "vinhomes",
    nameVi: "Vinhomes",
    nameEn: "Vinhomes JSC",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Vinhomes", "VHM"],
  },
  {
    ticker: "MSN",
    slug: "masan",
    instrumentSlug: "masan",
    nameVi: "Masan",
    nameEn: "Masan Group",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Masan", "MSN", "Tập đoàn Masan"],
  },
  {
    ticker: "MWG",
    slug: "mobile_world",
    instrumentSlug: "mobile_world",
    nameVi: "Thế Giới Di Động",
    nameEn: "Mobile World Investment Corp",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Thế Giới Di Động", "MWG", "Mobile World"],
  },
  {
    ticker: "TCB",
    slug: "techcombank",
    instrumentSlug: "techcombank",
    nameVi: "Techcombank",
    nameEn: "Vietnam Technological and Commercial Joint Stock Bank",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Techcombank", "TCB"],
  },
  {
    ticker: "ACB",
    slug: "acb",
    instrumentSlug: "acb",
    nameVi: "ACB",
    nameEn: "Asia Commercial Bank",
    type: "common_stock",
    priceScale: 3,
    aliases: ["ACB", "Ngân hàng Á Châu"],
  },
  {
    ticker: "VPB",
    slug: "vpbank",
    instrumentSlug: "vpbank",
    nameVi: "VPBank",
    nameEn: "Vietnam Prosperity Joint Stock Commercial Bank",
    type: "common_stock",
    priceScale: 3,
    aliases: ["VPBank", "VPB"],
  },
  {
    ticker: "BID",
    slug: "bidv",
    instrumentSlug: "bidv",
    nameVi: "BIDV",
    nameEn: "Bank for Investment and Development of Vietnam",
    type: "common_stock",
    priceScale: 3,
    aliases: ["BIDV", "BID"],
  },
  {
    ticker: "CTG",
    slug: "vietinbank",
    instrumentSlug: "vietinbank",
    nameVi: "VietinBank",
    nameEn: "Vietnam Joint Stock Commercial Bank for Industry and Trade",
    type: "common_stock",
    priceScale: 3,
    aliases: ["VietinBank", "CTG"],
  },
  {
    ticker: "GAS",
    slug: "pv_gas",
    instrumentSlug: "pv_gas",
    nameVi: "PV Gas",
    nameEn: "PetroVietnam Gas JSC",
    type: "common_stock",
    priceScale: 3,
    aliases: ["PV Gas", "GAS", "Tổng Công ty Khí Việt Nam"],
  },
  {
    ticker: "VRE",
    slug: "vincom_retail",
    instrumentSlug: "vincom_retail",
    nameVi: "Vincom Retail",
    nameEn: "Vincom Retail JSC",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Vincom Retail", "VRE"],
  },
  {
    ticker: "SSI",
    slug: "ssi_securities",
    instrumentSlug: "ssi_securities",
    nameVi: "SSI",
    nameEn: "SSI Securities Corporation",
    type: "common_stock",
    priceScale: 3,
    aliases: ["SSI", "Chứng khoán SSI"],
  },
  {
    ticker: "STB",
    slug: "sacombank",
    instrumentSlug: "sacombank",
    nameVi: "Sacombank",
    nameEn: "Saigon Thuong Tin Commercial Joint Stock Bank",
    type: "common_stock",
    priceScale: 3,
    aliases: ["Sacombank", "STB"],
  },
  {
    ticker: "HDB",
    slug: "hdbank",
    instrumentSlug: "hdbank",
    nameVi: "HDBank",
    nameEn: "Ho Chi Minh City Development Joint Stock Commercial Bank",
    type: "common_stock",
    priceScale: 3,
    aliases: ["HDBank", "HDB"],
  },
  // indices — issuer is the exchange publishing them
  {
    ticker: "VNINDEX",
    slug: "ho_chi_minh_stock_exchange",
    instrumentSlug: "vnindex",
    nameVi: "VN-Index",
    nameEn: "VN-Index",
    type: "index",
    priceScale: 0,
    aliases: ["VN-Index", "VNINDEX"],
  },
  {
    ticker: "VN30",
    slug: "ho_chi_minh_stock_exchange",
    instrumentSlug: "vn30",
    nameVi: "VN30",
    nameEn: "VN30 Index",
    type: "index",
    priceScale: 0,
    aliases: ["VN30", "VN30-Index"],
  },
];

const HOSE_ENTITY = {
  slug: "ho_chi_minh_stock_exchange",
  nameVi: "Sở Giao dịch Chứng khoán TP.HCM",
  nameEn: "Ho Chi Minh Stock Exchange",
  type: "organization" as const,
  aliases: ["HOSE", "Sở Giao dịch Chứng khoán Thành phố Hồ Chí Minh"],
};

const MIC = "XSTC";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const ONLY_LISTING = opt("listing");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const unixDay = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const today = isoDay(new Date());
const START = opt("start") ?? isoDay(new Date(Date.now() - 180 * 86400e3));
const END = opt("end") ?? today;
for (const [flag, v] of [
  ["--start", START],
  ["--end", END],
])
  if (!DATE_RE.test(v)) {
    console.error(`${flag} must be YYYY-MM-DD (got '${v}')`);
    process.exit(2);
  }

const c = connectDb();
await c.connect();

async function ensureEntity(
  slug: string,
  type: string,
  nameVi: string,
  nameEn: string,
  aliases: string[],
  ticker?: string,
  country = "VN",
): Promise<string> {
  const key = `${type === "organization" ? "organization" : "company"}:${slug}`;
  const ins = await c.query(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type, status, country_code)
     VALUES ($1,$2,$3,'active',$4)
     ON CONFLICT (canonical_key) DO NOTHING RETURNING id`,
    [
      key,
      nameVi,
      type === "organization" ? "organization" : "company",
      country,
    ],
  );
  const id =
    ins.rows[0]?.id ??
    (await c.query(`SELECT id FROM entities WHERE canonical_key=$1`, [key]))
      .rows[0].id;
  for (const a of new Set([nameVi, nameEn, ...aliases])) {
    await c.query(
      `INSERT INTO entity_aliases (entity_id, alias, normalized_alias, alias_type)
       VALUES ($1,$2,lower($2),$3) ON CONFLICT DO NOTHING`,
      [id, a, a === ticker ? "ticker_like" : "common_name"],
    );
  }
  return id as string;
}

async function ensureListing(
  e: VnEntry,
  issuerId: string,
  obsId: string,
): Promise<{ listingId: string; listingKey: string }> {
  const typeSlug = e.type === "index" ? "index" : "common_stock";
  const instrumentKey = `instrument:${e.instrumentSlug}:${typeSlug}`;
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

  // instrument version — mint only on semantic change
  const curV = await c.query(
    `SELECT iv.* FROM financial_instruments fi
       JOIN instrument_versions iv ON iv.id = fi.current_version_id
     WHERE fi.id=$1`,
    [instrumentId],
  );
  const attrs = {
    name: e.nameEn,
    asset_class: "equity",
    instrument_type: e.type,
    currency: e.type === "index" ? null : "VND",
    share_class: null,
    cfi: null,
    status: "active",
  };
  const changed =
    !curV.rows.length ||
    ["name", "asset_class", "instrument_type", "currency", "status"].some(
      (k) =>
        String((curV.rows[0] as Record<string, unknown>)[k] ?? "") !==
        String((attrs as Record<string, unknown>)[k] ?? ""),
    );
  if (changed) {
    const nv = await c.query(
      `INSERT INTO instrument_versions
         (instrument_id, version_no, name, asset_class, instrument_type,
          currency, share_class, cfi, observation_id, previous_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        instrumentId,
        ((curV.rows[0]?.version_no as number) ?? 0) + 1,
        attrs.name,
        attrs.asset_class,
        attrs.instrument_type,
        attrs.currency,
        attrs.share_class,
        attrs.cfi,
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

  const listingKey = `listing:${e.instrumentSlug}:${typeSlug}:${MIC.toLowerCase()}`;
  const venue = await c.query(`SELECT id FROM trading_venues WHERE mic=$1`, [
    MIC,
  ]);
  if (!venue.rows.length)
    throw new Error(`venue ${MIC} missing — run import-mic first`);
  const venueId = venue.rows[0].id as string;
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
       VALUES ($1,$2,$3,'VND',true,$4,$5) RETURNING id`,
      [
        listingId,
        ((curL.rows[0]?.version_no as number) ?? 0) + 1,
        e.ticker,
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
  // ticker as a venue-local identifier — provenance to the seed
  // assertion. No unique constraint on (scheme,value) → check-then-insert.
  const haveIdent = await c.query(
    `SELECT 1 FROM listing_identifiers
      WHERE listing_id=$1 AND scheme='local_security_code' AND value=$2
        AND id NOT IN (
          SELECT supersedes_identifier_id FROM listing_identifiers
           WHERE supersedes_identifier_id IS NOT NULL)`,
    [listingId, e.ticker],
  );
  if (!haveIdent.rows.length) {
    const li = await c.query(
      `INSERT INTO listing_identifiers
         (listing_id, scheme, value, provider, observation_id)
       VALUES ($1,'local_security_code',$2,'manual_verified',$3)
       RETURNING id`,
      [listingId, e.ticker, obsId],
    );
    await recordDerivation(
      c,
      { type: "listing_identifier", id: li.rows[0].id },
      obsId,
      "asserts",
    );
  }
  return { listingId, listingKey };
}

const summary = { seeded: 0, imported: 0, errors: [] as string[] };

// ── Phase 1: universe seed ────────────────────────────────────────────────
const universeObsId = DRY_RUN
  ? "dry"
  : await observe(c, {
      provider: "manual_verified",
      dataset: "vn_listing_universe",
      recordKey: "v1",
      payload: {
        assertedAt: today,
        mic: MIC,
        entries: VN_UNIVERSE.map((e) => ({
          ticker: e.ticker,
          instrumentSlug: e.instrumentSlug,
          type: e.type,
          nameVi: e.nameVi,
          nameEn: e.nameEn,
        })),
        hose: HOSE_ENTITY,
      },
    });

if (!DRY_RUN)
  await ensureEntity(
    HOSE_ENTITY.slug,
    "organization",
    HOSE_ENTITY.nameVi,
    HOSE_ENTITY.nameEn,
    HOSE_ENTITY.aliases,
  );

const listings: { listingId: string; listingKey: string; entry: VnEntry }[] =
  [];
for (const e of VN_UNIVERSE) {
  if (ONLY_LISTING && !e.ticker.includes(ONLY_LISTING.toUpperCase())) {
    // --listing matches canonical key tail or ticker
    if (!e.instrumentSlug.includes(ONLY_LISTING)) continue;
  }
  if (DRY_RUN) {
    listings.push({
      listingId: "dry",
      listingKey: `listing:${e.instrumentSlug}:${e.type === "index" ? "index" : "common_stock"}:${MIC.toLowerCase()}`,
      entry: e,
    });
    continue;
  }
  const issuerId = await ensureEntity(
    e.slug,
    e.type === "index" ? "organization" : "company",
    e.nameVi,
    e.nameEn,
    e.aliases,
    e.type === "index" ? undefined : e.ticker,
  );
  const { listingId, listingKey } = await ensureListing(
    e,
    issuerId,
    universeObsId,
  );
  listings.push({ listingId, listingKey, entry: e });
  summary.seeded++;
}
console.log(
  `seeded ${summary.seeded} listings (universe obs ${universeObsId})`,
);

// ── Phase 2: dchart bars ─────────────────────────────────────────────────
const targets = LIMIT ? listings.slice(0, LIMIT) : listings;
for (const { listingId, listingKey, entry } of targets) {
  const sym = resolveVndirectSymbol({ mic: MIC, ticker: entry.ticker });
  if (sym.kind !== "symbol") {
    summary.errors.push(`${entry.ticker}: ${sym.reason}`);
    continue;
  }
  const url =
    `https://dchart-api.vndirect.com.vn/dchart/history?symbol=${sym.symbol}` +
    `&resolution=D&from=${unixDay(START)}&to=${unixDay(END)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      summary.errors.push(`${entry.ticker}: http ${res.status}`);
      continue;
    }
    const payload: unknown = await res.json();
    const parsed = parseVndirectHistory(payload, {
      priceScale: entry.priceScale,
    });
    if (parsed.kind === "provider_error") {
      summary.errors.push(
        `${entry.ticker}: ${parsed.errorClass} ${parsed.detail}`,
      );
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `[dry] ${entry.ticker}: ${parsed.bars.length} bars ` +
          `${parsed.bars[0]?.sessionDate}→${parsed.bars.at(-1)?.sessionDate}`,
      );
      continue;
    }
    // raw payload lands BEFORE derived bars — provenance first, always
    const obsId = await observe(c, {
      provider: "vndirect",
      dataset: "dchart_eod",
      recordKey: `dchart/history/${sym.symbol}/${START}_${END}`,
      sourceUrl: url,
      payload,
    });
    const seriesId = await getOrCreateVndirectSeries(c, listingId, listingKey);
    const r = await applyDailyBars(c, seriesId, parsed.bars, obsId);
    summary.imported++;
    console.log(
      `${entry.ticker}: +${r.pointsInserted}pts +${r.versionsInserted}v` +
        (r.invalid.length ? ` INVALID:${r.invalid.length}` : ""),
    );
  } catch (e) {
    summary.errors.push(`${entry.ticker}: ${(e as Error).message}`);
  }
}

console.log(
  `done: ${summary.imported} imported, ${summary.errors.length} errors`,
);
for (const e of summary.errors) console.log(`  ! ${e}`);
await c.end();
process.exit(summary.errors.length ? 1 : 0);
