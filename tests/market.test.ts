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
  logReturn,
  marketPointChanged,
  parseAvDaily,
  simpleReturn,
  validateBar,
  type DailyBar,
} from "../lib/market";
import { applyDailyBars, getOrCreateSeries } from "../lib/db/market";
import { injectPool } from "../lib/db/pool";
import { getDailyBars, getInstrumentView } from "../lib/db/read";

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../db/migrations/0023_market_data_foundation.sql",
      import.meta.url,
    ),
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
  const bars = await getDailyBars(fx.listingId, { order: "asc" });
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
  const cur = await getDailyBars(fx.listingId);
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
