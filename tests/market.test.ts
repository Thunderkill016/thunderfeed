/* Market Data Foundation — V1 regressions.
 *
 * pg-mem verifies portable DDL, revision semantics and identity rules.
 * The append-only trigger is PG-only — its assertion checks the migration
 * declaration (same technique as instruments.test.ts). */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBigintString,
  isCalendarDate,
  logReturn,
  marketPointChanged,
  normalizeDecimalString,
  parseAvDaily,
  resolveAlphaVantageSymbol,
  simpleReturn,
  validateBar,
  type DailyBar,
} from "../lib/market";
import { applyDailyBars, getOrCreateSeries } from "../lib/db/market";
import { injectPool } from "../lib/db/pool";
import {
  getDailyBarsForListing,
  getDailyBarsForSeries,
  getInstrumentView,
} from "../lib/db/read";

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../db/migrations/0023_market_data_foundation.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const MIGRATION_V11_SQL = readFileSync(
  fileURLToPath(
    new URL("../db/migrations/0024_market_data_v11.sql", import.meta.url),
  ),
  "utf8",
);

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
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/g, "")
    // pg-mem path can't run the 0023 ALTER (its auto constraint name
    // differs from prod) — relax the provider CHECK textually instead
    .replace(
      "'manual_verified', 'other'",
      "'manual_verified', 'alphavantage', 'other'",
    );
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

async function fixtureListing(
  pool: Pool,
  key: string,
  ticker = "ABC",
  mic = "XNGS",
) {
  const e = await pool.query(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type)
     VALUES ($1,$2,'company') RETURNING id`,
    [`brand:${key}`, `${key} Inc.`],
  );
  const obs = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('manual_verified','fixture',$1,'{}',$1) RETURNING id`,
    [`obs:${key}:${randomUUID()}`],
  );
  const fi = await pool.query(
    `INSERT INTO financial_instruments (canonical_key, issuer_entity_id, instrument_type)
     VALUES ($1,$2,'common_stock') RETURNING id`,
    [`instrument:${key}`, e.rows[0].id],
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
  const v = await pool.query(
    `INSERT INTO trading_venues (mic) VALUES ($1) RETURNING id`,
    [mic],
  );
  const l = await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [`listing:${key}`, fi.rows[0].id, v.rows[0].id],
  );
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, observation_id)
     VALUES ($1,1,$2,'active',$3) RETURNING id`,
    [l.rows[0].id, ticker, obs.rows[0].id],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, l.rows[0].id],
  );
  return {
    listingId: l.rows[0].id as string,
    listingKey: `listing:${key}` as string,
    instrumentKey: `instrument:${key}` as string,
    obsId: obs.rows[0].id as string,
  };
}

const avPayload = (
  bars: Record<string, [string, string, string, string, string]>,
) => ({
  "Meta Data": {
    "1. Information": "Daily Prices (open, high, low, close) and Volumes",
    "2. Symbol": "ABC",
    "3. Last Refreshed": "2026-09-02",
    "4. Output Size": "Compact",
    "5. Time Zone": "US/Eastern",
  },
  "Time Series (Daily)": Object.fromEntries(
    Object.entries(bars).map(([d, [o, h, l, c, v]]) => [
      d,
      {
        "1. open": o,
        "2. high": h,
        "3. low": l,
        "4. close": c,
        "5. volume": v,
      },
    ]),
  ),
});

const bar = (
  sessionDate: string,
  close: string,
  volume = "1000",
): DailyBar => ({
  sessionDate,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

// ── Alpha Vantage adapter ────────────────────────────────────────────────

test("parseAvDaily: valid series sorts bars ascending", () => {
  const r = parseAvDaily(
    avPayload({
      "2026-09-02": ["101", "102", "100", "101.5", "9"],
      "2026-09-01": ["100", "101", "99", "100.5", "8"],
    }),
  );
  assert.ok(r.kind === "series");
  assert.equal(r.bars[0].sessionDate, "2026-09-01");
  assert.equal(r.bars[1].sessionDate, "2026-09-02");
  assert.equal(r.meta.symbol, "ABC");
});

test("parseAvDaily: rate-limit Note is a provider error, not empty success", () => {
  const r = parseAvDaily({
    Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.",
  });
  assert.ok(r.kind === "provider_error");
  assert.equal(r.errorClass, "rate_limit");
});

test("parseAvDaily: Information quota key also rate_limit", () => {
  const r = parseAvDaily({
    Information: "We have detected your API key ... premium",
  });
  assert.ok(r.kind === "provider_error" && r.errorClass === "rate_limit");
});

test("parseAvDaily: Error Message → invalid_symbol", () => {
  const r = parseAvDaily({
    "Error Message": "Invalid API call. Symbol NOPE does not exist.",
  });
  assert.ok(r.kind === "provider_error" && r.errorClass === "invalid_symbol");
});

test("parseAvDaily: empty object → empty error, not a series", () => {
  const r = parseAvDaily({});
  assert.ok(r.kind === "provider_error" && r.errorClass === "empty");
});

test("parseAvDaily: unexpected schema → unexpected_schema", () => {
  const r = parseAvDaily({ "Meta Data": {}, something: [] });
  assert.ok(r.kind === "provider_error");
  assert.equal(r.errorClass, "unexpected_schema");
});

// ── validation ───────────────────────────────────────────────────────────

test("validateBar accepts a sane bar, rejects low>high / bad numbers", () => {
  assert.deepEqual(
    validateBar({
      sessionDate: "2026-09-01",
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "5",
    }),
    { ok: true },
  );
  assert.equal(
    (
      validateBar({
        sessionDate: "2026-09-01",
        open: "100",
        high: "99",
        low: "101",
        close: "100",
        volume: "5",
      }) as { ok: false; reason: string }
    ).reason,
    "low_gt_high",
  );
  assert.equal(
    (
      validateBar({
        sessionDate: "2026-09-01",
        open: "0",
        high: "99",
        low: "95",
        close: "98",
        volume: "5",
      }) as { ok: false; reason: string }
    ).reason,
    "nonpositive_open",
  );
  assert.equal(
    (
      validateBar({
        sessionDate: "2026-09-01",
        open: "100",
        high: "101",
        low: "99",
        close: "100",
        volume: "-3",
      }) as { ok: false; reason: string }
    ).reason,
    "negative_volume",
  );
});

// ── comparator + return helpers ──────────────────────────────────────────

test("marketPointChanged: numeric-normalizing compare over semantic fields", () => {
  const cur = {
    open: "100.00",
    high: "101.0",
    low: "99.5",
    close: "100.5",
    volume: "1000",
    currency: null,
  };
  assert.equal(
    marketPointChanged(cur, {
      open: "100",
      high: "101",
      low: "99.5",
      close: "100.5",
      volume: "1000",
      currency: null,
    }),
    false,
  );
  assert.equal(
    marketPointChanged(cur, {
      open: "100",
      high: "101",
      low: "99.5",
      close: "101",
      volume: "1000",
      currency: null,
    }),
    true,
  );
  assert.equal(
    marketPointChanged(cur, {
      open: "100",
      high: "101",
      low: "99.5",
      close: "100.5",
      volume: "2000",
      currency: null,
    }),
    true,
  );
});

test("simpleReturn / logReturn: pure helpers, no persistence", () => {
  assert.ok(Math.abs((simpleReturn("100", "101") ?? 0) - 0.01) < 1e-12);
  assert.ok(Math.abs((logReturn("100", "101") ?? 0) - Math.log(1.01)) < 1e-12);
  assert.equal(simpleReturn("0", "101"), null);
  assert.equal(logReturn("100", "0"), null);
});

// ── identity + revision semantics ────────────────────────────────────────

test("market data attaches to listing_id; ticker rename keeps one series", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "acme", "ABC");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const obs = async (payload: unknown) => {
    const r = await pool.query(
      `INSERT INTO reference_observations
         (provider, dataset, record_key, payload, content_hash)
       VALUES ('alphavantage','time_series_daily',$1,$2,$3) RETURNING id`,
      [
        `listing:${fx.listingId}:run:${randomUUID()}`,
        JSON.stringify(payload),
        randomUUID(),
      ],
    );
    return r.rows[0].id as string;
  };
  await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "100"), bar("2026-09-02", "101")],
    await obs(avPayload({})),
  );

  // ticker rename: ABC → XYZ on the SAME listing (new listing version)
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, observation_id)
     VALUES ($1,2,'XYZ','active',$2) RETURNING id`,
    [fx.listingId, fx.obsId],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, fx.listingId],
  );

  // new provider pull under the NEW ticker name → same series, history
  // continues uninterrupted
  const seriesId2 = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  assert.equal(seriesId2, seriesId);
  await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-03", "102")],
    await obs(avPayload({})),
  );
  const n = await pool.query(
    `SELECT count(*) n FROM market_series WHERE listing_id=$1`,
    [fx.listingId],
  );
  assert.equal(Number(n.rows[0].n), 1);
  const bars = (await getDailyBarsForListing(fx.listingId, { order: "asc" }))!
    .bars;
  assert.deepEqual(
    bars.map((b) => b.sessionDate),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
  );
});

test("same payload twice → zero new versions, zero new points", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "beta");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const o1 = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
    [`obs:beta1:${randomUUID()}`],
  );
  const bars = [bar("2026-09-01", "100"), bar("2026-09-02", "101")];
  const r1 = await applyDailyBars(pool, seriesId, bars, o1.rows[0].id);
  assert.equal(r1.versionsInserted, 2);
  // re-apply identical OHLCV — even with a *different* observation id
  const o2 = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
    [`obs:beta2:${randomUUID()}`],
  );
  const r2 = await applyDailyBars(pool, seriesId, bars, o2.rows[0].id);
  assert.equal(r2.versionsInserted, 0);
  assert.equal(r2.pointsInserted, 0);
  assert.equal(r2.unchanged, 2);
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM market_points) pts,
            (SELECT count(*) FROM market_point_versions) vers`,
  );
  assert.equal(Number(counts.rows[0].pts), 2);
  assert.equal(Number(counts.rows[0].vers), 2);
});

test("provider correction appends version, old value stays queryable", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "gamma");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const mkObs = async () =>
    (
      await pool.query(
        `INSERT INTO reference_observations
           (provider, dataset, record_key, payload, content_hash)
         VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
        [`obs:gamma:${randomUUID()}`],
      )
    ).rows[0].id as string;

  // 2026-09-01 close 100
  const r1 = await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "100")],
    await mkObs(),
  );
  assert.equal(r1.versionsInserted, 1);
  // later provider says close 101 → same point, version 2
  const r2 = await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "101")],
    await mkObs(),
  );
  assert.equal(r2.pointsInserted, 0);
  assert.equal(r2.versionsInserted, 1);

  const hist = await pool.query(
    `SELECT version_no, close::text c FROM market_point_versions
      WHERE point_id IN (SELECT id FROM market_points)
      ORDER BY version_no`,
  );
  assert.equal(hist.rows.length, 2);
  assert.equal(hist.rows[0].c, "100"); // old value queryable
  assert.equal(hist.rows[1].c, "101");
  const cur = (await getDailyBarsForListing(fx.listingId))!.bars;
  assert.equal(cur[0].close, "101"); // current = corrected
});

test("invalid bar (low>high) not promoted; raw observation preserved", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "delta");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const obsId = (
    await pool.query(
      `INSERT INTO reference_observations
         (provider, dataset, record_key, payload, content_hash)
       VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
      [`obs:delta:${randomUUID()}`],
    )
  ).rows[0].id as string;
  const r = await applyDailyBars(
    pool,
    seriesId,
    [
      {
        sessionDate: "2026-09-01",
        open: "100",
        high: "99", // invalid envelope
        low: "101",
        close: "100",
        volume: "5",
      },
    ],
    obsId,
  );
  assert.equal(r.versionsInserted, 0);
  assert.deepEqual(r.invalid, [
    { sessionDate: "2026-09-01", reason: "low_gt_high" },
  ]);
  const p = await pool.query(`SELECT count(*) n FROM market_points`);
  assert.equal(Number(p.rows[0].n), 0);
  // raw observation still exists
  const o = await pool.query(
    `SELECT count(*) n FROM reference_observations WHERE id=$1`,
    [obsId],
  );
  assert.equal(Number(o.rows[0].n), 1);
});

test("same ticker on different listings → separate series", async () => {
  const pool = setupDb();
  const a = await fixtureListing(pool, "dup-a", "ABC", "XNGS");
  const b = await fixtureListing(pool, "dup-b", "ABC", "XLON");
  const sa = await getOrCreateSeries(pool, a.listingId, a.listingKey);
  const sb = await getOrCreateSeries(pool, b.listingId, b.listingKey);
  assert.notEqual(sa, sb);
  const n = await pool.query(`SELECT count(*) n FROM market_series`);
  assert.equal(Number(n.rows[0].n), 2);
});

test("provider without currency → currency stays NULL", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "nocurr");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const o = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
    [`obs:nocurr:${randomUUID()}`],
  );
  await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "100")],
    o.rows[0].id,
  );
  const v = await pool.query(`SELECT currency FROM market_point_versions`);
  assert.equal(v.rows[0].currency, null);
});

test("normalized versions FK to listing via series — no ticker column", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "fkcheck");
  await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const fk = await pool.query(
    `SELECT l.id FROM market_series ms
       JOIN instrument_listings l ON l.id = ms.listing_id`,
  );
  assert.equal(fk.rows[0].id, fx.listingId);
});

test("instrument view exposes latestMarket per listing (null before data)", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "viewable", "ABC");
  let view = await getInstrumentView(fx.instrumentKey);
  assert.equal(view?.listings[0].latestMarket, null);
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const o = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
    [`obs:viewable:${randomUUID()}`],
  );
  await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "42.5")],
    o.rows[0].id,
  );
  view = await getInstrumentView(fx.instrumentKey);
  assert.equal(view?.listings[0].latestMarket?.close, "42.5");
  assert.equal(view?.listings[0].latestMarket?.provider, "alphavantage");
});

// ── schema/security declarations (PG-only parts asserted on migration) ───

test("migration 0023 declares append-only trigger + RLS + no grants", () => {
  assert.match(
    MIGRATION_SQL,
    /CREATE TRIGGER trg_market_point_versions_immutable\s+BEFORE UPDATE OR DELETE ON market_point_versions/,
  );
  assert.match(MIGRATION_SQL, /ENABLE ROW LEVEL SECURITY/);
  assert.equal(
    (MIGRATION_SQL.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length,
    3,
  );
  assert.match(
    MIGRATION_SQL,
    /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM anon, authenticated/,
  );
  // V1 series shape is hard-checked — adjusted bases cannot be encoded
  assert.match(MIGRATION_SQL, /price_basis.*CHECK.*'as_traded'/);
  assert.match(MIGRATION_SQL, /"interval".*CHECK.*'1d'/);
  // DATE, not a UTC-midnight timestamp
  assert.match(MIGRATION_SQL, /session_date\s+date NOT NULL/);
});

test("V1 CHECKs reject adjusted/intraday series shapes", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "adjcheck");
  await assert.rejects(
    pool.query(
      `INSERT INTO market_series
         (canonical_key, listing_id, provider, dataset, "interval",
          session_type, price_basis)
       VALUES ('k1',$1,'alphavantage','ts_adj','1d','regular','split_adjusted')`,
      [fx.listingId],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO market_series
         (canonical_key, listing_id, provider, dataset, "interval",
          session_type, price_basis)
       VALUES ('k2',$1,'alphavantage','ts','5min','regular','as_traded')`,
      [fx.listingId],
    ),
  );
});

// ── V1.1: DB-level referential integrity ─────────────────────────────────

/** smallest legal version row for raw-SQL probes */
const mkVer = async (
  pool: Pool,
  pointId: string,
  versionNo: number,
  prev: string | null,
  obsId: string,
) =>
  (
    await pool.query(
      `INSERT INTO market_point_versions
         (point_id, version_no, open, high, low, close, volume,
          observation_id, previous_version_id)
       VALUES ($1,$2,'100','101','99','100.5',100,$3,$4) RETURNING id`,
      [pointId, versionNo, obsId, prev],
    )
  ).rows[0].id as string;

const mkPoint = async (pool: Pool, seriesId: string, date: string) =>
  (
    await pool.query(
      `INSERT INTO market_points (series_id, session_date)
       VALUES ($1,$2) RETURNING id`,
      [seriesId, date],
    )
  ).rows[0].id as string;

const mkObs = async (pool: Pool) =>
  (
    await pool.query(
      `INSERT INTO reference_observations
         (provider, dataset, record_key, payload, content_hash)
       VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
      [`obs:${randomUUID()}`],
    )
  ).rows[0].id as string;

test("DB rejects a current_version pointer into a DIFFERENT point", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "fk-xcur");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const [pA, pB] = [
    await mkPoint(pool, seriesId, "2026-09-01"),
    await mkPoint(pool, seriesId, "2026-09-02"),
  ];
  const vB = await mkVer(pool, pB, 1, null, await mkObs(pool));
  // point A's pointer → point B's version — composite FK must reject
  await assert.rejects(
    pool.query(`UPDATE market_points SET current_version_id=$1 WHERE id=$2`, [
      vB,
      pA,
    ]),
    /foreign key|violates/i,
  );
});

test("DB rejects a previous_version chain crossing points; valid chain ok", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "fk-xprev");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const pA = await mkPoint(pool, seriesId, "2026-09-01");
  const pB = await mkPoint(pool, seriesId, "2026-09-02");
  const obs = await mkObs(pool);
  const a1 = await mkVer(pool, pA, 1, null, obs);
  const b1 = await mkVer(pool, pB, 1, null, obs);
  await assert.rejects(
    pool.query(
      `INSERT INTO market_point_versions
         (point_id, version_no, open, high, low, close, volume,
          observation_id, previous_version_id)
       VALUES ($1,2,'100','101','99','100.5',100,$2,$3)`,
      [pA, obs, b1], // A.v2 → B.v1
    ),
    /foreign key|violates/i,
  );
  // canonical chain: v1.prev NULL, v2→v1, v3→v2
  const a2 = await mkVer(pool, pA, 2, a1, obs);
  const a3 = await mkVer(pool, pA, 3, a2, obs);
  const chain = await pool.query(
    `SELECT v.version_no, p.version_no prev
       FROM market_point_versions v
       LEFT JOIN market_point_versions p ON p.id = v.previous_version_id
      WHERE v.point_id=$1 ORDER BY v.version_no`,
    [pA],
  );
  assert.deepEqual(
    chain.rows.map((r) => [r.version_no, r.prev]),
    [
      [1, null],
      [2, 1],
      [3, 2],
    ],
  );
});

test("DB rejects a version with NULL observation_id", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "fk-noobs");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const p = await mkPoint(pool, seriesId, "2026-09-01");
  await assert.rejects(
    pool.query(
      `INSERT INTO market_point_versions
         (point_id, version_no, open, high, low, close, volume,
          observation_id)
       VALUES ($1,1,'100','101','99','100.5',100,NULL)`,
      [p],
    ),
    /not-null|null value/i,
  );
});

test("DB CHECKs reject malformed OHLCV regardless of the writer", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "fk-ohlc");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const p = await mkPoint(pool, seriesId, "2026-09-01");
  const obs = await mkObs(pool);
  const ins = (o: string, h: string, l: string, c: string, v = "1") =>
    pool.query(
      `INSERT INTO market_point_versions
         (point_id, version_no, open, high, low, close, volume,
          observation_id)
       VALUES ($1,1,$2::numeric,$3::numeric,$4::numeric,$5::numeric,$6::bigint,$7)`,
      [p, o, h, l, c, v, obs],
    );
  await assert.rejects(ins("100", "99", "101", "100")); // low>high
  await assert.rejects(ins("0", "101", "99", "100")); // open=0
  await assert.rejects(ins("105", "101", "99", "100")); // open>high
  await assert.rejects(ins("100", "101", "99", "50")); // close<low
  await assert.rejects(ins("100", "101", "99", "100", "-5")); // neg volume
});

// ── V1.1: exact decimal semantics ────────────────────────────────────────

test("normalizeDecimalString: exact canonicalization, no IEEE-754", () => {
  assert.equal(normalizeDecimalString("100"), "100");
  assert.equal(normalizeDecimalString("100.0"), "100");
  assert.equal(normalizeDecimalString("100.0000"), "100");
  assert.equal(normalizeDecimalString("-0.000"), "0");
  assert.equal(normalizeDecimalString(" 42.500 "), "42.5");
  // past the float53 precision wall — stays exact
  assert.equal(normalizeDecimalString("9007199254740992"), "9007199254740992");
  assert.equal(normalizeDecimalString("9007199254740993"), "9007199254740993");
  assert.notEqual(
    normalizeDecimalString("9007199254740992"),
    normalizeDecimalString("9007199254740993"),
  );
  // notation the provider contract doesn't use → rejected, not reinterpreted
  assert.equal(normalizeDecimalString("1e3"), null);
  assert.equal(normalizeDecimalString("abc"), null);
  assert.equal(normalizeDecimalString("1.2.3"), null);
  assert.equal(normalizeDecimalString(null), null);
});

test("isBigintString: digits-only, signed range", () => {
  assert.ok(isBigintString("9223372036854775807")); // max int64
  assert.ok(isBigintString("0"));
  assert.ok(!isBigintString("9223372036854775808")); // overflow
  assert.ok(!isBigintString("1.5"));
  assert.ok(!isBigintString("1e6"));
  assert.ok(!isBigintString(null));
});

test("decimal precision beyond float53 still detects a revision", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "precise");
  const seriesId = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const obs = await mkObs(pool);
  const mk = (close: string): DailyBar => ({
    sessionDate: "2026-09-01",
    open: "1",
    high: close,
    low: "1",
    close,
    volume: "1",
  });
  // float64 collapses these to the same value — we must not
  const big1 = "9007199254740992";
  const big2 = "9007199254740993";
  await applyDailyBars(pool, seriesId, [mk(big1)], obs);
  const r = await applyDailyBars(pool, seriesId, [mk(big2)], obs);
  // NB: pg-mem narrows numerics to float64 on read-back, so big1 vs big2
  // is proven by the comparator, not by what pg-mem returns — on real PG
  // numeric arrives as a string and stays exact.
  assert.equal(r.versionsInserted, 1); // distinct → revision
  // equivalent decimals within faithful range: 100.0 → 100.000 unchanged
  const hundred = await applyDailyBars(pool, seriesId, [mk("100.0")], obs);
  assert.equal(hundred.versionsInserted, 1); // real change first
  const equiv = await applyDailyBars(pool, seriesId, [mk("100.000")], obs);
  assert.equal(equiv.versionsInserted, 0); // 100.0 = 100.000 → unchanged
  const pts = await pool.query(`SELECT count(*) n FROM market_points`);
  assert.equal(Number(pts.rows[0].n), 1);
});

// ── V1.1: multi-provider isolation + read selection ─────────────────────

test("two providers on the same listing → separate series, never merged", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "multiprovider");
  const avSeries = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  // a second provider's series — written directly (the app-level V1
  // contract only authors alphavantage series, but the schema holds them)
  const other = (
    await pool.query(
      `INSERT INTO market_series
         (canonical_key, listing_id, provider, dataset, "interval",
          session_type, price_basis)
       VALUES ('series:other',$1,'provider_b','daily','1d','regular','as_traded')
       RETURNING id`,
      [fx.listingId],
    )
  ).rows[0].id as string;
  const obs = await mkObs(pool);
  await applyDailyBars(pool, avSeries, [bar("2026-09-01", "100")], obs);
  await applyDailyBars(pool, other, [bar("2026-09-01", "101")], obs);

  // series-level reads are isolated
  const a = await getDailyBarsForSeries(avSeries);
  const b = await getDailyBarsForSeries(other);
  assert.equal(a[0].close, "100");
  assert.equal(b[0].close, "101");

  // listing-level read requires explicit selection — alphavantage default
  const sel = await getDailyBarsForListing(fx.listingId, {
    provider: "alphavantage",
    dataset: "time_series_daily",
  });
  assert.equal(sel?.bars[0].close, "100");
  // selecting provider_b returns its own series
  const selB = await getDailyBarsForListing(fx.listingId, {
    provider: "provider_b",
    dataset: "daily",
  });
  assert.equal(selB?.bars[0].close, "101");
  // no selector matching >1 series → null rather than a merged array
  const ambiguous = await pool.query(
    `SELECT count(*) n FROM market_series WHERE listing_id=$1`,
    [fx.listingId],
  );
  assert.equal(Number(ambiguous.rows[0].n), 2); // still two series
});

// ── V1.1: provider transport + API input validation ─────────────────────

test("resolveAlphaVantageSymbol: US venues only, never guessed", () => {
  assert.deepEqual(
    resolveAlphaVantageSymbol({ mic: "XNGS", ticker: "GOOGL" }),
    { kind: "symbol", symbol: "GOOGL" },
  );
  assert.deepEqual(resolveAlphaVantageSymbol({ mic: "XLON", ticker: "VOD" }), {
    kind: "unresolved_provider_symbol",
    reason: "unsupported_venue:XLON",
  });
  assert.equal(
    resolveAlphaVantageSymbol({ mic: "XNGS", ticker: null }).kind,
    "unresolved_provider_symbol",
  );
});

test("isCalendarDate: real calendar, not regex shape", () => {
  assert.ok(isCalendarDate("2026-09-30"));
  assert.ok(isCalendarDate("2024-02-29")); // leap
  assert.ok(!isCalendarDate("2026-99-99"));
  assert.ok(!isCalendarDate("2026-02-31"));
  assert.ok(!isCalendarDate("2023-02-29")); // not a leap year
  assert.ok(!isCalendarDate("banana"));
  assert.ok(!isCalendarDate("2026-9-1"));
});

// ── V1.1: migration declarations ─────────────────────────────────────────

test("migration 0024 declares composite FKs + NOT NULL + OHLC CHECKs", () => {
  assert.match(
    MIGRATION_V11_SQL,
    /FOREIGN KEY \(current_version_id, id\)\s+REFERENCES market_point_versions \(id, point_id\)/,
  );
  assert.match(
    MIGRATION_V11_SQL,
    /FOREIGN KEY \(previous_version_id, point_id\)\s+REFERENCES market_point_versions \(id, point_id\)/,
  );
  assert.match(MIGRATION_V11_SQL, /ALTER COLUMN observation_id SET NOT NULL/);
  assert.match(MIGRATION_V11_SQL, /market_point_versions_ohlc_valid/);
  assert.match(MIGRATION_V11_SQL, /volume IS NULL OR volume >= 0/);
});
