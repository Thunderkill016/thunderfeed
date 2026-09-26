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
  deriveSeed,
  instrumentDescriptor,
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

test("instrumentDescriptor is type-aware, not hardcoded common_stock", () => {
  assert.deepEqual(instrumentDescriptor("ALPHABET INC-CL A", "common_stock"), [
    "class_a_common_stock",
    "A",
  ]);
  assert.deepEqual(
    instrumentDescriptor("ALPHABET INC-CL A", "depositary_receipt"),
    ["class_a_adr", "A"],
  );
  assert.deepEqual(instrumentDescriptor("ACME PFD SER A", "preferred_stock"), [
    "series_a_preferred_stock",
    "A",
  ]);
  assert.deepEqual(instrumentDescriptor("MICROSOFT CORP", "common_stock"), [
    "common_stock",
    null,
  ]);
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

// ── V1.1 regressions: durable reconciliation + provenance ─────────────────
// These drive the real apply path (lib/db/instruments.ts) on pg-mem.

import {
  applyInstrumentPlan,
  type ApplyOutcome,
  type ApplySources,
} from "../lib/db/instruments";

function mustApply(r: ApplyOutcome) {
  if (r.kind !== "applied") throw new Error(`unexpected conflict: ${r.reason}`);
  return r;
}
import type { InstrumentSeedPlan } from "../lib/instruments";

async function obsFixture(pool: Pool, key: string, provider = "openfigi") {
  const r = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ($1,'fixture',$2,'{}',$2) RETURNING id`,
    [provider, key],
  );
  return r.rows[0].id as string;
}

function seedPlan(
  over: Partial<InstrumentSeedPlan>,
  defaultObsId = "",
): InstrumentSeedPlan {
  const listings = (
    over.listings ?? [
      {
        listingKey: "listing:acme:common_stock:xngs",
        mic: "XNGS",
        ticker: "ACME",
        currency: "USD",
        figi: "BBG000VENUE1",
        obsId: "",
      },
    ]
  ).map((l) => ({ ...l, obsId: l.obsId || defaultObsId }));
  return {
    instrumentKey: "instrument:acme:common_stock",
    instrumentName: "ACME CORP",
    shareClass: null,
    instrumentType: "common_stock",
    issuerCik: "0000000001",
    currency: "USD",
    cfi: null,
    instrumentIdentifiers: (
      over.instrumentIdentifiers ?? [
        {
          scheme: "share_class_figi",
          value: "BBG001S5TEST",
          scope: "global",
          obsIds: [],
        },
        {
          scheme: "composite_figi",
          value: "BBG000COMPTE",
          scope: "composite",
          obsIds: [],
        },
      ]
    ).map((i) => ({
      ...i,
      obsIds: i.obsIds.length ? i.obsIds : [defaultObsId],
    })),
    ...over,
    listings,
  };
}

test("ticker rename: same shareClassFIGI → same instrument+listing, +1 version", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:acme_ren", "Acme Ren");
  const venue = await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  void venue;
  const sec = await obsFixture(pool, "sec:1", "sec_edgar");
  const f1 = await obsFixture(pool, "figi:1");
  const src: ApplySources = { figiObsIds: [f1], secObsId: sec };

  const r1 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:acme_ren:common_stock" }, f1),
      issuer,
      src,
    ),
  );
  // ticker rename ABC → XYZ, same shareClassFIGI + same venue figi
  const f2 = await obsFixture(pool, "figi:2");
  const plan2 = seedPlan(
    {
      instrumentKey: "instrument:acme_ren:common_stock",
      instrumentName: "ACME CORP",
      listings: [
        {
          listingKey: "listing:acme_ren:common_stock:xngs",
          mic: "XNGS",
          ticker: "XYZ",
          currency: "USD",
          figi: "BBG000VENUE1",
          obsId: f2,
        },
      ],
    },
    f2,
  );
  const r2 = mustApply(
    await applyInstrumentPlan(pool, plan2, issuer, {
      figiObsIds: [f2],
      secObsId: sec,
    }),
  );
  assert.equal(r2.instrumentId, r1.instrumentId);
  assert.deepEqual(r2.listingIds, r1.listingIds);
  const versions = await pool.query(
    `SELECT version_no, ticker FROM listing_versions WHERE listing_id=$1 ORDER BY version_no`,
    [r1.listingIds[0]],
  );
  assert.deepEqual(
    versions.rows.map((r) => [r.version_no, r.ticker]),
    [
      [1, "ACME"],
      [2, "XYZ"],
    ],
  );
});

test("company rename: same shareClassFIGI, new name → same instrument, +1 version", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:rename_co", "Rename Co");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:r", "sec_edgar");
  const f1 = await obsFixture(pool, "figi:r1");
  const r1 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({
        instrumentKey: "instrument:rename_co:common_stock",
        instrumentName: "RENAME CO",
        instrumentIdentifiers: [
          {
            scheme: "share_class_figi",
            value: "BBG001S5REN",
            scope: "global",
            obsIds: [],
          },
        ],
        listings: [
          {
            listingKey: "listing:rename_co:common_stock:xngs",
            mic: "XNGS",
            ticker: "REN",
            currency: "USD",
            figi: "BBG000VENUE9",
            obsId: f1,
          },
        ],
      }),
      issuer,
      { figiObsIds: [f1], secObsId: sec },
    ),
  );
  const f2 = await obsFixture(pool, "figi:r2");
  const r2 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({
        instrumentKey: "instrument:rename_co:common_stock",
        instrumentName: "RENAMED CORP", // name changed
        instrumentIdentifiers: [
          {
            scheme: "share_class_figi",
            value: "BBG001S5REN",
            scope: "global",
            obsIds: [],
          },
        ],
        listings: [
          {
            listingKey: "listing:rename_co:common_stock:xngs",
            mic: "XNGS",
            ticker: "REN",
            currency: "USD",
            figi: "BBG000VENUE9",
            obsId: f2,
          },
        ],
      }),
      issuer,
      { figiObsIds: [f2], secObsId: sec },
    ),
  );
  assert.equal(r2.instrumentId, r1.instrumentId);
  const vers = await pool.query(
    `SELECT version_no, name FROM instrument_versions
      WHERE instrument_id=$1 ORDER BY version_no`,
    [r1.instrumentId],
  );
  assert.deepEqual(
    vers.rows.map((r) => [r.version_no, r.name]),
    [
      [1, "RENAME CO"],
      [2, "RENAMED CORP"],
    ],
  );
  // unchanged rerun → no third version
  const r3 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({
        instrumentKey: "instrument:rename_co:common_stock",
        instrumentName: "RENAMED CORP",
        instrumentIdentifiers: [
          {
            scheme: "share_class_figi",
            value: "BBG001S5REN",
            scope: "global",
            obsIds: [],
          },
        ],
        listings: [
          {
            listingKey: "listing:rename_co:common_stock:xngs",
            mic: "XNGS",
            ticker: "REN",
            currency: "USD",
            figi: "BBG000VENUE9",
            obsId: f2,
          },
        ],
      }),
      issuer,
      { figiObsIds: [f2], secObsId: sec },
    ),
  );
  assert.equal(r3.instrumentVersionId, null);
});

test("two instruments may share the same CFI (classification, not identity)", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:cfi_a", "CFI A");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const f = await obsFixture(pool, "figi:cfi");
  const sec = await obsFixture(pool, "sec:cfi", "sec_edgar");
  const mk = (suffix: string, scfigi: string, figi: string) =>
    seedPlan({
      instrumentKey: `instrument:cfi_${suffix}:common_stock`,
      instrumentName: `CFI ${suffix} INC`,
      cfi: "ESVUFR",
      instrumentIdentifiers: [
        {
          scheme: "share_class_figi",
          value: scfigi,
          scope: "global",
          obsIds: [],
        },
      ],
      listings: [
        {
          listingKey: `listing:cfi_${suffix}:common_stock:xngs`,
          mic: "XNGS",
          ticker: suffix.toUpperCase(),
          currency: "USD",
          figi,
          obsId: f,
        },
      ],
    });
  const a = mustApply(
    await applyInstrumentPlan(
      pool,
      mk("a", "BBG001CFIA", "BBGVENCFIA"),
      issuer,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  const b = mustApply(
    await applyInstrumentPlan(
      pool,
      mk("b", "BBG001CFIB", "BBGVENCFIB"),
      issuer,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  assert.notEqual(a.instrumentId, b.instrumentId);
  const dup = await pool.query(
    `SELECT cfi, count(DISTINCT instrument_id) n FROM instrument_versions
      WHERE cfi='ESVUFR' GROUP BY cfi`,
  );
  assert.equal(Number(dup.rows[0].n), 2); // duplicate CFI is legal
});

test("multi-venue: same shareClassFIGI, distinct venue FIGIs → 1 instrument, 2 listings, none primary", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:multi", "Multi");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  await fixtureVenue(pool, "XNYS", "NYSE");
  const sec = await obsFixture(pool, "sec:m", "sec_edgar");
  const fa = await obsFixture(pool, "figi:m1");
  const fb = await obsFixture(pool, "figi:m2");
  const out = deriveSeed({
    issuerSlug: "multi",
    secRow: { cik: 1, name: "Multi", ticker: "MULT", exchange: "Nasdaq" },
    venues: [
      {
        mic: "XNGS",
        obsId: fa,
        results: [
          {
            figi: "BBG000VENA",
            ticker: "MULT",
            name: "MULTI INC",
            shareClassFIGI: "BBG001MULTI",
            compositeFIGI: "BBGCOMPMULT",
            securityType2: "Common Stock",
          },
        ],
      },
      {
        mic: "XNYS",
        obsId: fb,
        results: [
          {
            figi: "BBG000VENB",
            ticker: "MULT",
            name: "MULTI INC",
            shareClassFIGI: "BBG001MULTI",
            compositeFIGI: "BBGCOMPMULT",
            securityType2: "Common Stock",
          },
        ],
      },
    ],
  });
  assert.equal(out.kind, "plan");
  if (out.kind !== "plan") return;
  const r = mustApply(
    await applyInstrumentPlan(pool, out.plan, issuer, {
      figiObsIds: [fa],
      secObsId: sec,
    }),
  );
  assert.equal(r.listingIds.length, 2);
  const prim = await pool.query(
    `SELECT count(*) n FROM listing_versions lv
       JOIN instrument_listings l ON l.id = lv.listing_id
      WHERE l.instrument_id=$1 AND lv.is_primary_listing IS NOT NULL`,
    [r.instrumentId],
  );
  assert.equal(Number(prim.rows[0].n), 0); // no fake primary certainty
});

test("derivations trace instrument → SEC + OpenFIGI + ISO observations", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:prov", "Prov");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:p", "sec_edgar");
  const iso = await obsFixture(pool, "iso:p", "iso_10383");
  const f = await obsFixture(pool, "figi:p");
  const r = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:prov:common_stock" }, f),
      issuer,
      { figiObsIds: [f], secObsId: sec, venueObsIdByMic: { XNGS: iso } },
    ),
  );
  const d = await pool.query(
    `SELECT d.subject_type, d.role, ro.provider
       FROM master_derivations d
       JOIN reference_observations ro ON ro.id = d.observation_id
      WHERE d.instrument_id=$1 OR d.listing_id=$2 OR d.listing_version_id IN (
        SELECT id FROM listing_versions WHERE listing_id=$2)
      ORDER BY d.subject_type, d.role`,
    [r.instrumentId, r.listingIds[0]],
  );
  const providers = new Set(d.rows.map((x) => x.provider));
  assert.ok(providers.has("sec_edgar"));
  assert.ok(providers.has("openfigi"));
  assert.ok(providers.has("iso_10383"));
  assert.ok(
    d.rows.some(
      (x) =>
        x.subject_type === "listing_version" && x.role === "venue_reference",
    ),
  );
});

test("identity collision: same shareClassFIGI, different issuer → conflict", async () => {
  const pool = setupDb();
  const a = await fixtureIssuer(pool, "company:coll_a", "CollA");
  const b = await fixtureIssuer(pool, "company:coll_b", "CollB");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:c", "sec_edgar");
  const f = await obsFixture(pool, "figi:c");
  mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:coll_a:common_stock" }, f),
      a,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  // same shareClassFIGI now claimed by issuer B → conflict, no merge
  const coll = await applyInstrumentPlan(
    pool,
    seedPlan({ instrumentKey: "instrument:coll_b:common_stock" }, f),
    b,
    { figiObsIds: [f], secObsId: sec },
  );
  assert.equal(coll.kind, "conflict");
  if (coll.kind === "conflict")
    assert.match(coll.reason, /share_class_figi_issuer_mismatch/);
});

// ── V1.2 regressions: strict reconciliation + typed provenance ────────────

import { upsertVenue } from "../lib/db/instruments";
import type { MicRow } from "../lib/instruments";

test("provider type conflict: same shareClassFIGI, common_stock → ADR → conflict", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:tconf", "TConf");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:t", "sec_edgar");
  const f = await obsFixture(pool, "figi:t");
  mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:tconf:common_stock" }, f),
      issuer,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  // same scFIGI but provider now says ADR → conflict, NOT a type-mutating
  // instrument version
  const out = await applyInstrumentPlan(
    pool,
    seedPlan(
      {
        instrumentKey: "instrument:tconf:class_a_adr",
        instrumentType: "depositary_receipt",
      },
      f,
    ),
    issuer,
    { figiObsIds: [f], secObsId: sec },
  );
  assert.equal(out.kind, "conflict");
  if (out.kind === "conflict")
    assert.match(out.reason, /share_class_figi_type_mismatch/);
  // no version appended that would change the instrument's nature
  const n = await pool.query(
    `SELECT count(*) n FROM instrument_versions WHERE instrument_type='depositary_receipt'`,
  );
  assert.equal(Number(n.rows[0].n), 0);
});

test("venue conflict: same venue FIGI on a different venue → conflict", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:vconf", "VConf");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  await fixtureVenue(pool, "XNYS", "NYSE");
  const sec = await obsFixture(pool, "sec:v", "sec_edgar");
  const f = await obsFixture(pool, "figi:v");
  mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:vconf:common_stock" }, f),
      issuer,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  // same venue-level FIGI BBG000VENUE1 now reported on XNYS → conflict
  const out = await applyInstrumentPlan(
    pool,
    seedPlan(
      {
        instrumentKey: "instrument:vconf:common_stock",
        listings: [
          {
            listingKey: "listing:vconf:common_stock:xnys",
            mic: "XNYS",
            ticker: "ACME",
            currency: "USD",
            figi: "BBG000VENUE1",
            obsId: f,
          },
        ],
      },
      f,
    ),
    issuer,
    { figiObsIds: [f], secObsId: sec },
  );
  assert.equal(out.kind, "conflict");
  if (out.kind === "conflict")
    assert.match(out.reason, /listing_identity_conflict:venue_mismatch/);
});

test("instrument conflict: same venue FIGI on a different instrument → conflict", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:iconf", "IConf");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:i", "sec_edgar");
  const f = await obsFixture(pool, "figi:i");
  mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:iconf:common_stock" }, f),
      issuer,
      { figiObsIds: [f], secObsId: sec },
    ),
  );
  // a different instrument (different scFIGI → new identity) claims the
  // SAME venue-level FIGI → listing_identity_conflict
  const out = await applyInstrumentPlan(
    pool,
    seedPlan(
      {
        instrumentKey: "instrument:iconf:class_b_common_stock",
        shareClass: "B",
        instrumentIdentifiers: [
          {
            scheme: "share_class_figi",
            value: "BBG001OTHER",
            scope: "global",
            obsIds: [f],
          },
        ],
      },
      f,
    ),
    issuer,
    { figiObsIds: [f], secObsId: sec },
  );
  assert.equal(out.kind, "conflict");
  if (out.kind === "conflict")
    assert.match(out.reason, /listing_identity_conflict:instrument_mismatch/);
});

test("canonical key reuse verifies instrument+venue too", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:kconf", "KConf");
  const other = await fixtureIssuer(pool, "company:kother", "KOther");
  const vA = await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const vB = await fixtureVenue(pool, "XNYS", "NYSE");
  const sec = await obsFixture(pool, "sec:k", "sec_edgar");
  const f = await obsFixture(pool, "figi:k");
  // a pre-existing listing on canonical key K bound to (other instrument,
  // venue B) — a plan arriving for key K on venue A must conflict
  const strayInstrument = await pool.query(
    `INSERT INTO financial_instruments
       (canonical_key, issuer_entity_id, instrument_type)
     VALUES ('instrument:kother:common_stock',$1,'common_stock') RETURNING id`,
    [other],
  );
  await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ('listing:kconf:common_stock:xngs',$1,$2)`,
    [strayInstrument.rows[0].id, vB],
  );
  const out = await applyInstrumentPlan(
    pool,
    seedPlan(
      {
        instrumentKey: "instrument:kconf:common_stock",
        listings: [
          {
            listingKey: "listing:kconf:common_stock:xngs",
            mic: "XNGS",
            ticker: "KC",
            currency: "USD",
            figi: "BBG000NEWFIGI", // unseen → falls back to canonical key
            obsId: f,
          },
        ],
      },
      f,
    ),
    issuer,
    { figiObsIds: [f], secObsId: sec },
  );
  assert.equal(out.kind, "conflict");
  if (out.kind === "conflict")
    assert.match(out.reason, /listing_identity_conflict/);
  void vA;
});

test("typed derivations: subject_type/FK mismatch rejected by DB CHECK", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:td", "TD");
  const obs = await obsFixture(pool, "td:1");
  const fi = await pool.query(
    `INSERT INTO financial_instruments
       (canonical_key, issuer_entity_id, instrument_type)
     VALUES ('instrument:td:common_stock',$1,'common_stock') RETURNING id`,
    [issuer],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO master_derivations
         (subject_type, instrument_id, observation_id, role)
       VALUES ('listing',$1,$2,'asserts')`,
      [fi.rows[0].id, obs],
    ),
  );
});

test("ISO venue expiry-date change only → +1 venue version", async () => {
  const pool = setupDb();
  const obs = await obsFixture(pool, "iso:v", "iso_10383");
  const base: MicRow = {
    mic: "XTST",
    operatingMic: "XTST",
    micRole: "operating",
    marketName: "TEST EXCHANGE",
    legalEntityName: null,
    lei: null,
    marketCategory: null,
    acronym: null,
    countryCode: "US",
    city: "TEST",
    status: "active",
    validFrom: "2020-01-01",
    validTo: null,
  };
  await upsertVenue(pool, base, obs);
  const obs2 = await obsFixture(pool, "iso:v2", "iso_10383");
  const r = await upsertVenue(pool, { ...base, validTo: "2026-01-01" }, obs2);
  assert.equal(r.action, "version_appended");
  const n = await pool.query(
    `SELECT count(*) n FROM trading_venue_versions tvv
       JOIN trading_venues tv ON tv.id = tvv.venue_id
      WHERE tv.mic='XTST'`,
  );
  assert.equal(Number(n.rows[0].n), 2);
  // and an unchanged rerun appends nothing
  const obs3 = await obsFixture(pool, "iso:v3", "iso_10383");
  const r3 = await upsertVenue(pool, { ...base, validTo: "2026-01-01" }, obs3);
  assert.equal(r3.action, "unchanged");
});

test("unchanged state + new observation → 0 new versions, +derivations", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:refresh", "Refresh");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  const sec = await obsFixture(pool, "sec:rf", "sec_edgar");
  const f1 = await obsFixture(pool, "figi:rf1");
  const r1 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:refresh:common_stock" }, f1),
      issuer,
      { figiObsIds: [f1], secObsId: sec },
    ),
  );
  // provider re-observation of identical state under a new observation id
  const f2 = await obsFixture(pool, "figi:rf2");
  const r2 = mustApply(
    await applyInstrumentPlan(
      pool,
      seedPlan({ instrumentKey: "instrument:refresh:common_stock" }, f2),
      issuer,
      { figiObsIds: [f2], secObsId: sec },
    ),
  );
  assert.equal(r2.instrumentId, r1.instrumentId);
  assert.equal(r2.instrumentVersionId, null); // no semantic version
  const iv = await pool.query(
    `SELECT count(*) n FROM instrument_versions WHERE instrument_id=$1`,
    [r1.instrumentId],
  );
  assert.equal(Number(iv.rows[0].n), 1);
  const lv = await pool.query(
    `SELECT count(*) n FROM listing_versions WHERE listing_id=$1`,
    [r1.listingIds[0]],
  );
  assert.equal(Number(lv.rows[0].n), 1);
  // but provenance grew: the new observation corroborates current versions
  const corr = await pool.query(
    `SELECT count(*) n FROM master_derivations d
       JOIN instrument_versions iv ON iv.id = d.instrument_version_id
      WHERE iv.instrument_id=$1 AND d.observation_id=$2 AND d.role='corroborates'`,
    [r1.instrumentId, f2],
  );
  assert.ok(Number(corr.rows[0].n) >= 1);
});

test("multi-venue: composite derivations trace their own observations", async () => {
  const pool = setupDb();
  const issuer = await fixtureIssuer(pool, "company:mv", "MV");
  await fixtureVenue(pool, "XNGS", "NASDAQ GS");
  await fixtureVenue(pool, "XLON", "LSE");
  const sec = await obsFixture(pool, "sec:mv", "sec_edgar");
  const o1 = await obsFixture(pool, "figi:o1");
  const o2 = await obsFixture(pool, "figi:o2");
  const out = deriveSeed({
    issuerSlug: "mv",
    secRow: { cik: 1, name: "MV INC", ticker: "MV", exchange: "Nasdaq" },
    venues: [
      {
        mic: "XNGS",
        obsId: o1,
        results: [
          {
            figi: "BBG000VAAA",
            ticker: "MV",
            name: "MV INC",
            shareClassFIGI: "BBG001MVSC",
            compositeFIGI: "BBGC1",
            securityType2: "Common Stock",
          },
        ],
      },
      {
        mic: "XLON",
        obsId: o2,
        results: [
          {
            figi: "BBG000VBBB",
            ticker: "MV",
            name: "MV INC",
            shareClassFIGI: "BBG001MVSC",
            compositeFIGI: "BBGC2",
            securityType2: "Common Stock",
          },
        ],
      },
    ],
  });
  assert.equal(out.kind, "plan");
  if (out.kind !== "plan") return;
  const r = mustApply(
    await applyInstrumentPlan(pool, out.plan, issuer, {
      figiObsIds: [o1, o2],
      secObsId: sec,
    }),
  );
  assert.equal(r.listingIds.length, 2);
  const idents = await pool.query(
    `SELECT ii.value, array_agg(d.observation_id ORDER BY d.observation_id) obs
       FROM instrument_identifiers ii
       LEFT JOIN master_derivations d ON d.instrument_identifier_id = ii.id
      WHERE ii.instrument_id=$1
      GROUP BY ii.value ORDER BY ii.value`,
    [r.instrumentId],
  );
  const byVal = Object.fromEntries(
    idents.rows.map((x) => [x.value, (x.obs as string[]).sort()]),
  );
  assert.deepEqual(byVal["BBGC1"], [o1]);
  assert.deepEqual(byVal["BBGC2"], [o2]);
  assert.deepEqual(byVal["BBG001MVSC"], [o1, o2].sort());
});
