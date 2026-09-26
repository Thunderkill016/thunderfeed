/* Financial Instrument Master — schema + semantics tests.
 *
 * pg-mem verifies portable DDL, derivation logic, and version semantics.
 * Trigger enforcement is PG-only — those assertions check the migration
 * declarations (same technique as the 0018/0019 regression tests). */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classDescriptor,
  deriveSeed,
  parseFigiMappingResponse,
  parseIsoMicCsv,
  parseSecTickersExchange,
} from "../lib/instruments";
import { injectPool } from "../lib/db/pool";
import { getEntityEvents, getInstrumentView } from "../lib/db/read";

function setupDb() {
  const db = newDb();
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n")
    .replace(
      /CREATE OR REPLACE FUNCTION uuid_v7[\s\S]*?LANGUAGE plpgsql VOLATILE;/,
      "",
    )
    .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/g, "");
  db.public.registerFunction({
    name: "uuid_v7",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  db.public.none(sql);
  const pg = db.adapters.createPg();
  injectPool(new pg.Pool() as unknown as Pool);
  return new pg.Pool() as unknown as Pool;
}

async function fixtureIssuer(
  pool: Pool,
  key: string,
  name: string,
  type = "company",
) {
  const found = await pool.query(
    `SELECT id FROM entities WHERE canonical_key=$1`,
    [key],
  );
  if (found.rows.length) return found.rows[0].id as string;
  const r = await pool.query(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type)
     VALUES ($1,$2,$3) RETURNING id`,
    [key, name, type],
  );
  return r.rows[0].id as string;
}

async function fixtureVenue(pool: Pool, mic: string, name: string) {
  const v = await pool.query(
    `INSERT INTO trading_venues (mic) VALUES ($1) RETURNING id`,
    [mic],
  );
  const ver = await pool.query(
    `INSERT INTO trading_venue_versions
       (venue_id, version_no, market_name, mic_role, status)
     VALUES ($1,1,$2,'operating','active') RETURNING id`,
    [v.rows[0].id, name],
  );
  await pool.query(
    `UPDATE trading_venues SET current_version_id=$1 WHERE id=$2`,
    [ver.rows[0].id, v.rows[0].id],
  );
  return v.rows[0].id as string;
}

async function fixtureInstrumentListing(
  pool: Pool,
  issuerId: string,
  venueId: string,
  key: string,
  ticker: string,
) {
  const obs = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('manual_verified','fixture',$1,'{}',$1) RETURNING id`,
    [`obs:${key}`],
  );
  const fi = await pool.query(
    `INSERT INTO financial_instruments (canonical_key, issuer_entity_id, instrument_type)
     VALUES ($1,$2,'common_stock') RETURNING id`,
    [`instrument:${key}`, issuerId],
  );
  const iv = await pool.query(
    `INSERT INTO instrument_versions
       (instrument_id, version_no, name, instrument_type, observation_id)
     VALUES ($1,1,$2,'common_stock',$3) RETURNING id`,
    [fi.rows[0].id, `${key} stock`, obs.rows[0].id],
  );
  await pool.query(
    `UPDATE financial_instruments SET current_version_id=$1 WHERE id=$2`,
    [iv.rows[0].id, fi.rows[0].id],
  );
  const l = await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [`listing:${key}`, fi.rows[0].id, venueId],
  );
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, currency, status, observation_id)
     VALUES ($1,1,$2,'USD','active',$3) RETURNING id`,
    [l.rows[0].id, ticker, obs.rows[0].id],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, l.rows[0].id],
  );
  return {
    instrumentId: fi.rows[0].id as string,
    listingId: l.rows[0].id as string,
    obsId: obs.rows[0].id as string,
  };
}

// ── parsers ───────────────────────────────────────────────────────────────

test("ISO 10383 CSV parser extracts MIC rows", () => {
  const csv = `"MIC","OPERATING MIC","OPRT/SGMT","MARKET NAME-INSTITUTION DESCRIPTION","LEGAL ENTITY NAME","LEI","MARKET CATEGORY CODE","ACRONYM","ISO COUNTRY CODE (ISO 3166)","CITY","WEBSITE","STATUS","CREATION DATE","LAST UPDATE DATE","LAST VALIDATION DATE","EXPIRY DATE","COMMENTS"
"XNAS","XNAS","OPRT","NASDAQ - ALL MARKETS","NASDAQ, INC.","","RMKT","NASDAQ","US","NEW YORK","WWW.NASDAQ.COM","ACTIVE","20071105","20071105","","",""
"XNYS","XNYS","OPRT","NEW YORK STOCK EXCHANGE, INC.","NYSE","","RMKT","NYSE","US","NEW YORK","WWW.NYSE.COM","ACTIVE","20071105","20071105","","",""`;
  const rows = parseIsoMicCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mic, "XNAS");
  assert.equal(rows[0].micRole, "operating");
  assert.equal(rows[0].marketName, "NASDAQ - ALL MARKETS");
  assert.equal(rows[1].countryCode, "US");
});

test("SEC company_tickers_exchange parser", () => {
  const rows = parseSecTickersExchange({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1652044, "Alphabet Inc.", "GOOGL", "Nasdaq"],
      [1652044, "Alphabet Inc.", "GOOG", "Nasdaq"],
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cik, 1652044);
});

test("OpenFIGI mapping response → results / error", () => {
  const ok = parseFigiMappingResponse({
    data: [{ figi: "BBG000B9XRY4", ticker: "AAPL", name: "APPLE INC" }],
  });
  assert.ok("results" in ok && ok.results[0].figi === "BBG000B9XRY4");
  const err = parseFigiMappingResponse({ error: "not found" });
  assert.ok("error" in err);
});

test("classDescriptor parses share class from issuer names", () => {
  assert.deepEqual(classDescriptor("ALPHABET INC-CL A"), [
    "class_a_common_stock",
    "A",
  ]);
  assert.deepEqual(classDescriptor("MICROSOFT CORP"), ["common_stock", null]);
});

// ── Phase 22: conservative promotion ──────────────────────────────────────

test("deriveSeed: OpenFIGI ticker mismatch → provider_conflict", () => {
  const out = deriveSeed({
    issuerSlug: "alphabet",
    secRow: {
      cik: 1652044,
      name: "Alphabet Inc.",
      ticker: "GOOGL",
      exchange: "Nasdaq",
    },
    venues: [
      {
        mic: "XNGS",
        obsId: "o1",
        results: [{ figi: "BBG009S39JX6", ticker: "GOOG" }],
      },
    ],
  });
  assert.equal(out.kind, "conflict");
});

test("deriveSeed: no venue candidates → unresolved, nothing promoted", () => {
  const out = deriveSeed({
    issuerSlug: "x",
    secRow: { cik: 1, name: "X", ticker: "X", exchange: "UnknownVenue" },
    venues: [],
  });
  assert.equal(out.kind, "unresolved");
});

test("deriveSeed: happy path produces A/C distinct plans, multi-venue listings", () => {
  const a = deriveSeed({
    issuerSlug: "alphabet",
    secRow: {
      cik: 1652044,
      name: "Alphabet Inc.",
      ticker: "GOOGL",
      exchange: "Nasdaq",
    },
    venues: [
      {
        mic: "XNGS",
        obsId: "o1",
        results: [
          {
            figi: "BBG009S3L3X3",
            ticker: "GOOGL",
            name: "ALPHABET INC-CL A",
            shareClassFIGI: "BBG001S5N2V5",
            compositeFIGI: "BBG009S3L3X3",
            securityType2: "Common Stock",
          },
        ],
      },
      // a second venue listing the same share class → two listings
      {
        mic: "XNMS",
        obsId: "o2",
        results: [
          {
            figi: "BBG009S3L4Y9",
            ticker: "GOOGL",
            name: "ALPHABET INC-CL A",
            shareClassFIGI: "BBG001S5N2V5",
            compositeFIGI: "BBG009S3L3X3",
            securityType2: "Common Stock",
          },
        ],
      },
    ],
  });
  const cshare = deriveSeed({
    issuerSlug: "alphabet",
    secRow: {
      cik: 1652044,
      name: "Alphabet Inc.",
      ticker: "GOOG",
      exchange: "Nasdaq",
    },
    venues: [
      {
        mic: "XNGS",
        obsId: "o3",
        results: [
          {
            figi: "BBG009S39JX6",
            ticker: "GOOG",
            name: "ALPHABET INC-CL C",
            shareClassFIGI: "BBG001S5N399",
            compositeFIGI: "BBG009S39JX6",
            securityType2: "Common Stock",
          },
        ],
      },
    ],
  });
  assert.equal(a.kind, "plan");
  assert.equal(cshare.kind, "plan");
  if (a.kind === "plan" && cshare.kind === "plan") {
    assert.notEqual(a.plan.instrumentKey, cshare.plan.instrumentKey);
    assert.equal(a.plan.shareClass, "A");
    assert.equal(cshare.plan.shareClass, "C");
    assert.equal(a.plan.listings.length, 2);
    assert.equal(a.plan.listings[0].mic, "XNGS");
    assert.equal(a.plan.listings[1].mic, "XNMS");
  }
});

// ── Phase 23: historical behavior ─────────────────────────────────────────

test("ticker mutation appends a new listing version, old retained", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:acme", "Acme");
  const venue = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const { listingId, obsId } = await fixtureInstrumentListing(
    pool,
    issuer,
    venue,
    "acme",
    "ACME",
  );
  const cur = await pool.query(
    `SELECT current_version_id FROM instrument_listings WHERE id=$1`,
    [listingId],
  );
  const v2 = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, currency, status, observation_id, previous_version_id)
     VALUES ($1,2,'ACMX','USD','active',$2,$3) RETURNING id`,
    [listingId, obsId, cur.rows[0].current_version_id],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [v2.rows[0].id, listingId],
  );
  const hist = await pool.query(
    `SELECT version_no, ticker FROM listing_versions WHERE listing_id=$1 ORDER BY version_no`,
    [listingId],
  );
  assert.deepEqual(
    hist.rows.map((r) => r.ticker),
    ["ACME", "ACMX"],
  );
});

test("venue change creates a second listing, instrument id unchanged", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:mover", "Mover");
  const v1 = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const v2 = await fixtureVenue(pool, "XNYS", "NYSE");
  const { instrumentId } = await fixtureInstrumentListing(
    pool,
    issuer,
    v1,
    "mover:xnas",
    "MVR",
  );
  const l2 = await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ('listing:mover:xnys',$1,$2) RETURNING id`,
    [instrumentId, v2],
  );
  await pool.query(
    `INSERT INTO listing_versions (listing_id, version_no, ticker, status)
     VALUES ($1,1,'MVR','active')`,
    [l2.rows[0].id],
  );
  const n = await pool.query(
    `SELECT count(DISTINCT instrument_id) n, count(*) listings
       FROM instrument_listings WHERE instrument_id=$1`,
    [instrumentId],
  );
  assert.equal(Number(n.rows[0].n), 1); // same identity, two venue lines
  assert.equal(Number(n.rows[0].listings), 2);
});

test("delisting marks listing inactive; instrument survives", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:gone", "Gone");
  const venue = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const { instrumentId, listingId } = await fixtureInstrumentListing(
    pool,
    issuer,
    venue,
    "gone",
    "GONE",
  );
  await pool.query(
    `UPDATE instrument_listings SET status='delisted' WHERE id=$1`,
    [listingId],
  );
  const i = await pool.query(
    `SELECT status FROM financial_instruments WHERE id=$1`,
    [instrumentId],
  );
  assert.equal(i.rows[0].status, "active");
});

test("identifier persists across ticker change (append-only assertions)", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:persist", "Persist");
  const venue = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const { instrumentId, listingId, obsId } = await fixtureInstrumentListing(
    pool,
    issuer,
    venue,
    "persist",
    "PRS",
  );
  await pool.query(
    `INSERT INTO instrument_identifiers
       (instrument_id, scheme, value, provider, observation_id)
     VALUES ($1,'share_class_figi','BBG001S5N2V5','openfigi',$2)`,
    [instrumentId, obsId],
  );
  // ticker changes — the share-class FIGI assertion stays attached to the
  // same instrument id (identity outlives market symbol)
  const cur = await pool.query(
    `SELECT current_version_id FROM instrument_listings WHERE id=$1`,
    [listingId],
  );
  const v2 = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, previous_version_id)
     VALUES ($1,2,'PRSX','active',$2) RETURNING id`,
    [listingId, cur.rows[0].current_version_id],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [v2.rows[0].id, listingId],
  );
  const ids = await pool.query(
    `SELECT value FROM instrument_identifiers WHERE instrument_id=$1`,
    [instrumentId],
  );
  assert.equal(ids.rows[0].value, "BBG001S5N2V5");
});

test("same ticker on two venues does not collide", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:dup", "Dup");
  const v1 = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const v2 = await fixtureVenue(pool, "XSTC", "HOSE");
  await fixtureInstrumentListing(pool, issuer, v1, "dup:xnas", "ABC");
  // same ticker on another venue — a different instrument entirely
  const i2 = await pool.query(
    `INSERT INTO financial_instruments (canonical_key, issuer_entity_id, instrument_type)
     VALUES ('instrument:dup:xstc_line',$1,'common_stock') RETURNING id`,
    [issuer],
  );
  const l2 = await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ('listing:dup:xstc',$1,$2) RETURNING id`,
    [i2.rows[0].id, v2],
  );
  await pool.query(
    `INSERT INTO listing_versions (listing_id, version_no, ticker, status)
     VALUES ($1,1,'ABC','active')`,
    [l2.rows[0].id],
  );
  const sameTicker = await pool.query(
    `SELECT l.venue_id, lv.ticker FROM listing_versions lv
       JOIN instrument_listings l ON l.id = lv.listing_id
      WHERE lv.ticker='ABC' ORDER BY l.venue_id`,
  );
  assert.equal(sameTicker.rows.length, 2);
});

test("issuer→instruments: Alphabet A/C stay distinct, brand ≠ issuer", async () => {
  const pool = setupDb();
  const alphabet = await fixtureIssuer(
    pool,
    "company:alphabet",
    "Alphabet Inc.",
  );
  await fixtureIssuer(pool, "brand:google", "Google", "brand"); // brand, not company
  const venue = await fixtureVenue(pool, "XNAS", "NASDAQ");
  await fixtureInstrumentListing(
    pool,
    alphabet,
    venue,
    "alphabet:class_a_common_stock",
    "GOOGL",
  );
  await fixtureInstrumentListing(
    pool,
    alphabet,
    venue,
    "alphabet:class_c_common_stock",
    "GOOG",
  );

  const view = await getEntityEvents("company:alphabet");
  assert.equal(view.financialInstruments.length, 2);
  const keys = view.financialInstruments.map((i) => i.canonicalKey).sort();
  assert.deepEqual(keys, [
    "instrument:alphabet:class_a_common_stock",
    "instrument:alphabet:class_c_common_stock",
  ]);
  const ids = new Set(view.financialInstruments.map((i) => i.id));
  assert.equal(ids.size, 2);

  // a brand has no issuer→instrument rows even though names collide
  const brand = await getEntityEvents("brand:google");
  assert.equal(brand.financialInstruments.length, 0);
});

test("getInstrumentView returns issuer + identifiers + listings + provenance", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:nvidia", "NVIDIA CORP");
  const venue = await fixtureVenue(pool, "XNAS", "NASDAQ");
  const { obsId } = await fixtureInstrumentListing(
    pool,
    issuer,
    venue,
    "nvidia:common_stock",
    "NVDA",
  );
  const view = await getInstrumentView("instrument:nvidia:common_stock");
  assert.ok(view);
  assert.equal(view.issuer?.canonicalKey, "company:nvidia");
  assert.equal(view.listings[0].ticker, "NVDA");
  assert.equal(view.listings[0].venue.mic, "XNAS");
  assert.equal(view.versionCount, 1);
  void obsId;
});

test("append-only guards declared on all instrument history tables", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../db/migrations/0020_instrument_master.sql", import.meta.url),
    ),
    "utf8",
  );
  for (const t of [
    "reference_observations",
    "trading_venue_versions",
    "instrument_versions",
    "listing_versions",
    "instrument_identifiers",
    "listing_identifiers",
  ]) {
    assert.match(
      sql,
      new RegExp(`BEFORE UPDATE OR DELETE ON ${t}`),
      `missing append-only trigger on ${t}`,
    );
  }
  // RLS + revoke declared for every new table
  for (const t of [
    "reference_observations",
    "trading_venues",
    "trading_venue_versions",
    "financial_instruments",
    "instrument_versions",
    "instrument_identifiers",
    "instrument_listings",
    "listing_versions",
    "listing_identifiers",
  ]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY`),
    );
    assert.match(sql, new RegExp(`CREATE TABLE ${t}`));
  }
});

test("CIK stays on entities, ticker stays on listings — never instrument ids", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../db/migrations/0020_instrument_master.sql", import.meta.url),
    ),
    "utf8",
  );
  assert.match(
    sql,
    /CHECK \(scheme IN \(\s*'isin','share_class_figi','composite_figi','cfi','other'/,
  );
  assert.match(sql, /scheme IN \(\s*'figi','local_security_code','other'/);
  // no UNIQUE constraint may cover the ticker column
  assert.doesNotMatch(sql, /UNIQUE\s*\([^)]*\bticker\b/i);
});
