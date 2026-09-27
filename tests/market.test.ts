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
  compareDailySeries,
  isBigintString,
  isCalendarDate,
  logReturn,
  marketPointChanged,
  normalizeDecimalString,
  parseAvDaily,
  parseBinanceKlines,
  parseCsv,
  parseErApiRate,
  parseGiavangHistory,
  parseTiingoEod,
  resolveAlphaVantageSymbol,
  resolveTiingoSymbol,
  simpleReturn,
  validateBar,
  type DailyBar,
} from "../lib/market";
import {
  applyDailyBars,
  getOrCreateMarketSeries,
  getOrCreateSeries,
  getOrCreateTiingoEodSeries,
  getOrCreateVndirectSeries,
  resolveSignalOutcomes,
} from "../lib/db/market";
import { injectPool } from "../lib/db/pool";
import {
  getDailyBarsForListing,
  getDailyBarsForSeries,
  getInstrumentView,
  isoDay,
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
    // pg-mem path can't run the 0023/0025/0026 ALTERs (its auto constraint
    // name differs from prod) — relax the provider/price-basis CHECKs
    // textually instead
    .replace(
      "'manual_verified', 'other'",
      "'manual_verified', 'alphavantage', 'tiingo', 'giavang', 'binance', 'er_api', 'other'",
    )
    .replace(
      "price_basis IN ('as_traded')",
      "price_basis IN ('as_traded','provider_adjusted','quoted')",
    )
    // 0033 widens these CHECKs PG-ONLY — same textual relax for pg-mem
    .replace(
      "'bond','note','etf','fund','index','future','option','other'",
      "'bond','note','etf','fund','index','future','option','commodity','crypto','fx_pair','other'",
    )
    .replace(
      "'equity','fixed_income','fund','index','commodity','derivative','other'",
      "'equity','fixed_income','fund','index','commodity','derivative','crypto','fx','other'",
    )
    // 0032 delta-feed CHECKs are PG-ONLY; pg-mem keeps the 0028 originals —
    // relax them textually the same way as the provider/price-basis checks
    .replace(
      "'ca_declared', 'ca_updated'",
      "'ca_declared', 'ca_updated', 'market_move'",
    )
    .replace(
      "(point_id IS NULL) <> (action_id IS NULL)",
      // 0032 adds a third subject column pg-mem can't see yet — relax to
      // "not both", which still catches the both-set violation
      "(point_id IS NULL) OR (action_id IS NULL)",
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

// ── V1.2: Tiingo dual-provider ───────────────────────────────────────────
// NB: Tiingo's real CSV order is date,close,high,low,open,volume,... —
// the fixture mirrors it so the name-based column mapping is what we test
const TIINGO_HEADER =
  "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor";
const tiingoCsv = (rows: string[]) =>
  `${TIINGO_HEADER}\r\n${rows.join("\r\n")}\r\n`;
const tiingoRow = (
  date: string,
  o: string,
  h: string,
  l: string,
  c: string,
  v: string,
  adjC = c,
  div = "0",
  split = "1",
) =>
  `${date},${c},${h},${l},${o},${v},${adjC},${h},${l},${o},${v},${div},${split}`;

test("parseTiingoEod: valid CSV → DailyBar[] with exact decimal strings", () => {
  const r = parseTiingoEod({
    status: 200,
    body: tiingoCsv([
      // ISO timestamps from the provider reduce to the session date —
      // date part only, no timezone shifting
      tiingoRow(
        "2026-09-02T00:00:00.000Z",
        "100.0000",
        "102.5",
        "99.9",
        "101.5",
        "1500000",
      ),
      tiingoRow(
        "2026-09-01T00:00:00.000Z",
        "100",
        "101",
        "99",
        "100.0",
        "1499900",
      ),
    ]),
  });
  assert.ok(r.kind === "series");
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].sessionDate, "2026-09-01"); // sorted ascending
  assert.equal(r.bars[1].sessionDate, "2026-09-02");
  // raw strings preserved byte-exact — no Number() anywhere
  assert.equal(r.bars[1].open, "100.0000");
  assert.equal(r.bars[0].close, "100.0");
  assert.equal(r.bars[0].volume, "1499900");
});

test("parseTiingoEod: large exact decimal survives the CSV path", () => {
  const big = "9007199254740992.5"; // past float53 precision
  const r = parseTiingoEod({
    status: 200,
    body: tiingoCsv([tiingoRow("2026-09-01", "1", big, "1", big, "1")]),
  });
  assert.ok(r.kind === "series");
  assert.equal(r.bars[0].close, big); // identical string, not a float
});

test("parseTiingoEod: empty volume → NULL, never fabricated 0", () => {
  const r = parseTiingoEod({
    status: 200,
    body: tiingoCsv(["2026-09-01,100,101,99,100.5,,100,101,99,100.5,,0,1"]),
  });
  assert.ok(r.kind === "series");
  assert.equal(r.bars[0].volume, null);
});

test("parseCsv: quoted fields and escaped quotes", () => {
  const rows = parseCsv('a,b\n"1,234","say ""hi"""\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1,234", 'say "hi"'],
  ]);
});

test("parseTiingoEod: adjusted quarantine — adjClose ≠ close keeps RAW close", () => {
  const r = parseTiingoEod({
    status: 200,
    body: tiingoCsv([
      // split-adjusted close 95.2 vs raw close 100 — raw wins for V1
      tiingoRow(
        "2026-09-01",
        "100",
        "101",
        "99",
        "100",
        "5000",
        "95.2",
        "0.5",
        "1.05",
      ),
    ]),
  });
  assert.ok(r.kind === "series");
  assert.equal(r.bars[0].close, "100"); // raw close, NOT the 95.2 adjClose
  // the DailyBar shape cannot even carry adjusted/corporate-action fields
  assert.deepEqual(Object.keys(r.bars[0]).sort(), [
    "close",
    "high",
    "low",
    "open",
    "sessionDate",
    "volume",
  ]);
});

test("parseTiingoEod: provider errors classified, never promoted", () => {
  const cases: [number, string, string][] = [
    [401, `{"detail":"Error: API token required"}`, "unauthorized"],
    [403, `{"detail":"Error: forbidden"}`, "unauthorized"],
    [404, `{"detail":"Error: Ticker NOPE not supported"}`, "invalid_symbol"],
    [429, `{"detail":"Error: monthly request limit"}`, "rate_limit"],
    [500, "server error", "api_error"],
    [200, "", "empty"],
    [200, `{"detail":"weird"}`, "unexpected_schema"], // JSON where CSV expected
    [200, "date,open\n2026-09-01,", "unexpected_schema"], // missing columns
    [200, tiingoCsv(["2026-09-01,100,101,99,100.5"]), "unexpected_schema"], // ragged row
    [
      200,
      tiingoCsv(["banana,100,101,99,100.5,5,1,1,1,1,1,0,1"]),
      "unexpected_schema",
    ], // bad date
    [200, TIINGO_HEADER, "empty"], // header only, zero rows
  ];
  for (const [status, body, klass] of cases) {
    const r = parseTiingoEod({ status, body });
    assert.equal(
      r.kind,
      "provider_error",
      `status=${status} body=${body.slice(0, 40)}`,
    );
    assert.equal(
      r.errorClass,
      klass,
      `status=${status} body=${body.slice(0, 40)}`,
    );
  }
});

test("resolveTiingoSymbol: verified US venues only, never guessed", () => {
  assert.deepEqual(resolveTiingoSymbol({ mic: "XNGS", ticker: "AAPL" }), {
    kind: "symbol",
    symbol: "AAPL",
  });
  assert.deepEqual(resolveTiingoSymbol({ mic: "XNYS", ticker: "ORCL" }), {
    kind: "symbol",
    symbol: "ORCL",
  });
  assert.deepEqual(resolveTiingoSymbol({ mic: "XLON", ticker: "VOD" }), {
    kind: "unresolved_provider_symbol",
    reason: "unsupported_venue:XLON",
  });
  assert.equal(
    resolveTiingoSymbol({ mic: "XNGS", ticker: " " }).kind,
    "unresolved_provider_symbol",
  );
});

test("tiingo eod series: ticker rename keeps listing identity", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "tirenam");
  const s1 = await getOrCreateTiingoEodSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, observation_id)
     VALUES ($1,2,'NEWTK','active',$2) RETURNING id`,
    [fx.listingId, fx.obsId],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, fx.listingId],
  );
  const s2 = await getOrCreateTiingoEodSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  assert.equal(s2, s1); // transport symbol renamed — identity untouched
});

test("tiingo eod: idempotent rerun + correction appends version", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "ticorr");
  const seriesId = await getOrCreateTiingoEodSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  const obs = async () =>
    (
      await pool.query(
        `INSERT INTO reference_observations
           (provider, dataset, record_key, payload, content_hash)
         VALUES ('tiingo','eod_daily',$1,'{}',$1) RETURNING id`,
        [`obs:ticorr:${randomUUID()}`],
      )
    ).rows[0].id as string;
  const bars = [bar("2026-09-01", "100"), bar("2026-09-02", "101")];
  const r1 = await applyDailyBars(pool, seriesId, bars, await obs());
  assert.equal(r1.versionsInserted, 2);
  const r2 = await applyDailyBars(pool, seriesId, bars, await obs());
  assert.equal(r2.versionsInserted, 0);
  assert.equal(r2.pointsInserted, 0);
  // correction: same date, corrected close
  const r3 = await applyDailyBars(
    pool,
    seriesId,
    [bar("2026-09-01", "100.5")],
    await obs(),
  );
  assert.equal(r3.versionsInserted, 1);
  assert.equal(r3.pointsInserted, 0);
  const hist = await pool.query(
    `SELECT v.version_no, v.close::text c
       FROM market_point_versions v
       JOIN market_points mp ON mp.id = v.point_id
      WHERE mp.session_date='2026-09-01' ORDER BY v.version_no`,
  );
  assert.deepEqual(
    hist.rows.map((x) => x.c),
    ["100", "100.5"],
  );
});

// ── dual-provider: two assertions, divergence recorded, never merged ─────

test("alpha=100 + tiingo=101 same listing/date → two series, divergence, no overwrite", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "dual");
  const avSeries = await getOrCreateSeries(pool, fx.listingId, fx.listingKey);
  const tiSeries = await getOrCreateTiingoEodSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  assert.notEqual(avSeries, tiSeries);
  const avObs = (
    await pool.query(
      `INSERT INTO reference_observations
         (provider, dataset, record_key, payload, content_hash)
       VALUES ('alphavantage','time_series_daily',$1,'{}',$1) RETURNING id`,
      [`obs:dual-av:${randomUUID()}`],
    )
  ).rows[0].id as string;
  const tiObs = (
    await pool.query(
      `INSERT INTO reference_observations
         (provider, dataset, record_key, payload, content_hash)
       VALUES ('tiingo','eod_daily',$1,'{}',$1) RETURNING id`,
      [`obs:dual-ti:${randomUUID()}`],
    )
  ).rows[0].id as string;

  const avBar = bar("2026-09-01", "100");
  const tiBar = bar("2026-09-01", "101");
  await applyDailyBars(pool, avSeries, [avBar], avObs);
  await applyDailyBars(pool, tiSeries, [tiBar], tiObs);

  // two points on the same calendar date — one per series
  const pts = await pool.query(
    `SELECT count(*) n FROM market_points WHERE session_date='2026-09-01'`,
  );
  assert.equal(Number(pts.rows[0].n), 2);

  // each version's provenance points at ITS provider's observation
  const prov = await pool.query(
    `SELECT ms.provider, ro.provider obs_provider, v.close::text c
       FROM market_point_versions v
       JOIN market_points mp ON mp.id = v.point_id
       JOIN market_series ms ON ms.id = mp.series_id
       JOIN reference_observations ro ON ro.id = v.observation_id`,
  );
  assert.equal(prov.rows.length, 2);
  for (const r of prov.rows) assert.equal(r.provider, r.obs_provider);

  // comparison flags divergence — nothing was overwritten
  const cmp = compareDailySeries([avBar], [tiBar]);
  assert.equal(cmp[0].kind, "compared");
  if (cmp[0].kind === "compared") {
    assert.equal(cmp[0].agreement, "price_divergence");
    assert.deepEqual(cmp[0].divergentFields, ["open", "high", "low", "close"]);
    assert.equal(cmp[0].closeDiff, 1);
  }
  // reads stay isolated
  assert.equal((await getDailyBarsForSeries(avSeries))[0].close, "100");
  assert.equal((await getDailyBarsForSeries(tiSeries))[0].close, "101");
  const avSel = await getDailyBarsForListing(fx.listingId, {
    provider: "alphavantage",
    dataset: "time_series_daily",
    priceBasis: "as_traded",
  });
  const tiSel = await getDailyBarsForListing(fx.listingId, {
    provider: "tiingo",
    dataset: "eod_daily",
    priceBasis: "as_traded",
  });
  assert.equal(avSel?.series.id, avSeries);
  assert.equal(tiSel?.series.id, tiSeries);
});

test("compareDailySeries: equivalent decimals agree (100 = 100.000)", async () => {
  const a = bar("2026-09-01", "100");
  const t: DailyBar = {
    ...a,
    open: "100.000",
    high: "100.000",
    low: "100.000",
    close: "100.000",
  };
  const cmp = compareDailySeries([a], [t]);
  assert.equal(cmp[0].kind, "compared");
  if (cmp[0].kind === "compared") {
    assert.equal(cmp[0].agreement, "exact_agreement");
    assert.deepEqual(cmp[0].divergentFields, []);
  }
});

test("compareDailySeries: volume-only divergence + missing sessions", () => {
  const a = [
    { ...bar("2026-09-01", "100"), volume: "5000" },
    bar("2026-09-02", "101"),
  ];
  const t = [
    { ...bar("2026-09-01", "100"), volume: "6000" },
    bar("2026-09-03", "102"),
  ];
  const cmp = compareDailySeries(a, t);
  assert.equal(cmp[0].kind, "compared");
  if (cmp[0].kind === "compared")
    assert.equal(cmp[0].agreement, "volume_divergence");
  assert.equal(cmp[1].kind, "missing_in_tiingo");
  assert.equal(cmp[2].kind, "missing_in_alpha");
});

test("isoDay: local-midnight Date never shifts the session date", () => {
  // the 2026 pilot bug: pg parses DATE as local-midnight Date; formatting
  // through toISOString() shifted 2026-09-25 → 2026-09-24 in UTC+7
  assert.equal(isoDay(new Date(2026, 8, 25)), "2026-09-25"); // local ctor
  assert.equal(isoDay(new Date(2000, 0, 1)), "2000-01-01"); // month/day pad
  assert.equal(isoDay("2026-09-25"), "2026-09-25"); // string passthrough
});

test("migration 0025 adds tiingo to provider allowlist, no new tables", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../db/migrations/0025_market_provider_tiingo.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(sql, /'tiingo'/);
  assert.match(sql, /'alphavantage'/); // preserved, not replaced
  assert.equal(sql.match(/CREATE TABLE/g), null);
  assert.equal(sql.match(/ALTER TABLE instrument_|trading_venues/g), null);
});

test("parseVndirectHistory: valid series scales thousand-VND to VND", async () => {
  const { parseVndirectHistory } = await import("../lib/market");
  const r = parseVndirectHistory(
    {
      t: [1758844800, 1759104000],
      o: [56.883, 56.513],
      h: [57.16, 56.605],
      l: [56.513, 55.68],
      c: [56.513, 55.773],
      v: [2489900, 5130400],
      s: "ok",
    },
    { priceScale: 3 },
  );
  assert.equal(r.kind, "series");
  if (r.kind !== "series") return;
  // 56.513 (thousand) → "56513" — exact decimal shift, no IEEE-754
  assert.equal(r.bars[0].close, "56513");
  assert.equal(r.bars[0].open, "56883");
  assert.equal(r.bars[1].close, "55773");
  assert.equal(r.bars[0].sessionDate, "2025-09-26");
  assert.equal(r.bars[0].volume, "2489900");
});

test("parseVndirectHistory: index points stay unscaled", async () => {
  const { parseVndirectHistory } = await import("../lib/market");
  const r = parseVndirectHistory(
    {
      t: [1758844800],
      o: [1666.68],
      h: [1671.43],
      l: [1652.65],
      c: [1660.7],
      v: [899321657],
      s: "ok",
    },
    { priceScale: 0 },
  );
  assert.equal(r.kind, "series");
  if (r.kind !== "series") return;
  assert.equal(r.bars[0].close, "1660.7");
});

test("parseVndirectHistory: non-ok status is provider_error, never empty series", async () => {
  const { parseVndirectHistory } = await import("../lib/market");
  const bad = parseVndirectHistory({ s: "error" });
  assert.equal(bad.kind, "provider_error");
  const nodata = parseVndirectHistory({ s: "no_data" });
  assert.equal(nodata.kind, "provider_error");
  if (nodata.kind === "provider_error")
    assert.equal(nodata.errorClass, "empty");
  const missing = parseVndirectHistory({ s: "ok", t: [] });
  assert.equal(missing.kind, "provider_error");
});

test("shiftDecimal: exact powers of ten without floats", async () => {
  const { shiftDecimal } = await import("../lib/market");
  assert.equal(shiftDecimal(56.513, 3), "56513");
  assert.equal(shiftDecimal("0.001", 3), "1");
  assert.equal(shiftDecimal("-1.5", 2), "-150");
  assert.equal(shiftDecimal("abc", 3), null);
});

test("resolveVndirectSymbol: VN MICs only, never guessed", async () => {
  const { resolveVndirectSymbol } = await import("../lib/market");
  for (const mic of ["XSTC", "HSTC", "XHNX"]) {
    assert.deepEqual(resolveVndirectSymbol({ mic, ticker: "VNM" }), {
      kind: "symbol",
      symbol: "VNM",
    });
  }
  assert.equal(
    resolveVndirectSymbol({ mic: "XNGS", ticker: "VNM" }).kind,
    "unresolved_provider_symbol",
  );
  assert.equal(
    resolveVndirectSymbol({ mic: "XSTC", ticker: null }).kind,
    "unresolved_provider_symbol",
  );
});

test("migration 0031 adds vndirect to provider allowlist, no new tables", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../db/migrations/0031_vndirect_provider.sql", import.meta.url),
    ),
    "utf8",
  );
  assert.match(sql, /'vndirect'/);
  assert.match(sql, /'imf'/); // preserved, not replaced
  assert.equal(sql.match(/CREATE TABLE/g), null);
});

test("dailyMovePct: null-safe pct between session closes", async () => {
  const { dailyMovePct } = await import("../lib/market");
  assert.ok(Math.abs(dailyMovePct("100", "107")! - 7) < 1e-9);
  assert.ok(Math.abs(dailyMovePct("32.3", "31.6")! + 2.167) < 0.001);
  assert.equal(dailyMovePct("0", "5"), null);
  assert.equal(dailyMovePct(null, "5"), null);
  assert.equal(dailyMovePct("abc", "5"), null);
});

test("market_move delta: material fresh-session moves only", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(
    pool,
    `mv${randomUUID().slice(0, 8)}`,
    "VNM",
    "XSTC",
  );
  const { getOrCreateVndirectSeries } = await import("../lib/db/market");
  const seriesId = await getOrCreateVndirectSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  const obs = async () =>
    (
      await pool.query(
        `INSERT INTO reference_observations
           (provider, dataset, record_key, payload, content_hash)
         VALUES ('tiingo','dchart_eod',$1,'{}',$1) RETURNING id`,
        [`obs:${randomUUID()}`],
      )
    ).rows[0].id as string;
  const bar = (d: string, c: string): DailyBar => ({
    sessionDate: d,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: "1000",
  });
  const day = (back: number) =>
    new Date(Date.now() - back * 86400e3).toISOString().slice(0, 10);

  // base session — no prior close, no delta
  await applyDailyBars(pool, seriesId, [bar(day(1), "100")], await obs());
  // fresh +7% session → one delta
  const r = await applyDailyBars(
    pool,
    seriesId,
    [bar(day(0), "107")],
    await obs(),
  );
  assert.equal(r.deltas, 1);
  const dd = await pool.query(
    `SELECT kind, materiality, summary FROM data_deltas
      WHERE market_point_id IS NOT NULL`,
  );
  assert.equal(dd.rows.length, 1);
  assert.equal(dd.rows[0].kind, "market_move");
  assert.match(dd.rows[0].summary, /VNM \+7\.0% phiên/);

  // sub-threshold move — nothing
  const r2 = await applyDailyBars(
    pool,
    seriesId,
    [bar(day(0), "107.5")], // correction, not a new session
    await obs(),
  );
  assert.equal(r2.deltas, 0);
  // stale backfill (+100% on an old date) — nothing
  const r3 = await applyDailyBars(
    pool,
    seriesId,
    [bar("2020-01-03", "50"), bar("2020-01-06", "150")],
    await obs(),
  );
  assert.equal(r3.deltas, 0);
});

// ── Alt-asset parsers (0033) ─────────────────────────────────────────────

test("giavang: bid/ask collapses to quoted convention, sell=0 → single quote", () => {
  const r = parseGiavangHistory(
    {
      success: true,
      history: [
        {
          date: "2026-09-26",
          prices: { SJL1L10: { buy: 141400000, sell: 144400000 } },
        },
        {
          date: "2026-09-25",
          prices: { SJL1L10: { buy: 141000000, sell: 144000000 } },
        },
      ],
    },
    { code: "SJL1L10" },
  );
  assert.equal(r.kind, "series");
  if (r.kind !== "series") return;
  assert.equal(r.bars.length, 2);
  // open=low=buy, high=close=sell — sorted ascending by date
  assert.deepEqual(
    {
      o: r.bars[0].open,
      l: r.bars[0].low,
      h: r.bars[0].high,
      c: r.bars[0].close,
    },
    { o: "141000000", l: "141000000", h: "144000000", c: "144000000" },
  );
  // day missing our code is skipped, not an error
  const r2 = parseGiavangHistory(
    {
      success: true,
      history: [{ date: "2026-09-26", prices: { OTHER: { buy: 1, sell: 2 } } }],
    },
    { code: "SJL1L10" },
  );
  assert.equal(r2.kind, "provider_error");
  if (r2.kind === "provider_error") assert.equal(r2.errorClass, "empty");
  // sell=0 collapses to the single quote (world spot)
  const r3 = parseGiavangHistory(
    {
      success: true,
      history: [
        { date: "2026-09-26", prices: { XAUUSD: { buy: 4286.2, sell: 0 } } },
      ],
    },
    { code: "XAUUSD" },
  );
  assert.equal(r3.kind, "series");
  if (r3.kind === "series") assert.equal(r3.bars[0].close, "4286.2");
  // success:false is a provider refusal
  const r4 = parseGiavangHistory(
    { success: false, error: "rate_limited" },
    { code: "X" },
  );
  assert.equal(r4.kind, "provider_error");
  if (r4.kind === "provider_error") assert.equal(r4.errorClass, "api_error");
});

test("binance klines → OHLCV bars; malformed rows refuse", () => {
  const r = parseBinanceKlines([
    [
      1790467200000,
      "84433.11",
      "85117.64",
      "84257.07",
      "84893.89",
      "5437.78",
      1790553599999,
    ],
    [
      1790380800000,
      "84100.00",
      "84473.58",
      "83798.00",
      "84433.10",
      "8058.06",
      1790467199999,
    ],
  ]);
  assert.equal(r.kind, "series");
  if (r.kind !== "series") return;
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].sessionDate, "2026-09-26");
  assert.equal(r.bars[0].close, "84433.1"); // decimals canonicalize (trailing zeros trimmed)
  assert.equal(r.bars[1].sessionDate, "2026-09-27");
  assert.equal(r.bars[1].volume, "5437");
  // malformed row → refuse whole payload
  const bad = parseBinanceKlines([[1790467200000, "x", "1", "1", "1", "1"]]);
  assert.equal(bad.kind, "provider_error");
  // empty array → genuine empty window
  const empty = parseBinanceKlines([]);
  assert.equal(empty.kind, "provider_error");
  if (empty.kind === "provider_error") assert.equal(empty.errorClass, "empty");
});

test("er-api: single point rate → all bar fields equal", () => {
  const r = parseErApiRate(
    {
      result: "success",
      time_last_update_utc: "Sun, 27 Sep 2026 00:00:01 +0000",
      rates: { VND: 25952.106627 },
    },
    { quote: "VND" },
  );
  assert.equal(r.kind, "series");
  if (r.kind !== "series") return;
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].open, "25952.106627");
  assert.equal(r.bars[0].close, r.bars[0].open);
  const bad = parseErApiRate({ result: "error" }, { quote: "VND" });
  assert.equal(bad.kind, "provider_error");
});

// ── signal_outcomes + per-series thresholds (0033) ───────────────────────

test("series metadata threshold: gold regime mints delta at 1.5%", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "goldboard", "SJC9999", "GOLDVN");
  const seriesId = await getOrCreateMarketSeries(pool, {
    listingId: fx.listingId,
    listingKey: fx.listingKey,
    provider: "giavang",
    dataset: "gold_board_daily",
    priceBasis: "quoted",
  });
  await pool.query(`UPDATE market_series SET metadata=$1 WHERE id=$2`, [
    JSON.stringify({ materialMovePct: 1.5, highMovePct: 3 }),
    seriesId,
  ]);
  const obs = async () =>
    (
      await pool.query(
        `INSERT INTO reference_observations
           (provider, dataset, record_key, payload, content_hash)
         VALUES ('giavang','gold_board_daily',$1,'{}',$1) RETURNING id`,
        [`obs:${randomUUID()}`],
      )
    ).rows[0].id as string;
  const bar = (d: string, buy: string, sell: string): DailyBar => ({
    sessionDate: d,
    open: buy,
    high: sell,
    low: buy,
    close: sell,
    volume: null,
  });
  const day = (back: number) =>
    new Date(Date.now() - back * 86400e3).toISOString().slice(0, 10);

  await applyDailyBars(
    pool,
    seriesId,
    [bar(day(1), "100", "102")],
    await obs(),
  );
  // +1.96% sell-side move — under the 5% equity default, over gold's 1.5%
  const r = await applyDailyBars(
    pool,
    seriesId,
    [bar(day(0), "102", "104")],
    await obs(),
  );
  assert.equal(r.deltas, 1);
  const dd = await pool.query(
    `SELECT summary FROM data_deltas WHERE kind='market_move'`,
  );
  assert.match(dd.rows[0].summary, /SJC9999 \+2\.0% phiên/);
  // the delta mints its own scorecard: 3 pending outcome rows
  const so = await pool.query(
    `SELECT horizon_sessions, status FROM signal_outcomes
      WHERE delta_id = (SELECT id FROM data_deltas WHERE kind='market_move' LIMIT 1)
      ORDER BY horizon_sessions`,
  );
  assert.deepEqual(
    so.rows.map((x) => [x.horizon_sessions, x.status]),
    [
      [1, "pending"],
      [5, "pending"],
      [20, "pending"],
    ],
  );
});

test("signal outcomes resolve at T+N sessions and expire stale pendings", async () => {
  const pool = setupDb();
  const fx = await fixtureListing(pool, "scorecard", "ABC", "XNGS");
  const seriesId = await getOrCreateVndirectSeries(
    pool,
    fx.listingId,
    fx.listingKey,
  );
  const obs = async () =>
    (
      await pool.query(
        `INSERT INTO reference_observations
           (provider, dataset, record_key, payload, content_hash)
         VALUES ('tiingo','fixture',$1,'{}',$1) RETURNING id`,
        [`obs:${randomUUID()}`],
      )
    ).rows[0].id as string;
  const bar = (d: string, c: string): DailyBar => ({
    sessionDate: d,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: null,
  });
  const day = (back: number) =>
    new Date(Date.now() - back * 86400e3).toISOString().slice(0, 10);

  // signal session: +10% fresh move
  await applyDailyBars(pool, seriesId, [bar(day(2), "100")], await obs());
  await applyDailyBars(pool, seriesId, [bar(day(1), "110")], await obs());
  // T+1 session lands at 115 (+4.5% from signal close)
  await applyDailyBars(pool, seriesId, [bar(day(0), "115")], await obs());
  const r = await resolveSignalOutcomes(pool);
  assert.equal(r.resolved, 1);
  const so = await pool.query(
    `SELECT horizon_sessions, status, move_pct FROM signal_outcomes
      ORDER BY horizon_sessions`,
  );
  assert.equal(so.rows[0].status, "resolved");
  assert.ok(Math.abs(Number(so.rows[0].move_pct) - 4.5455) < 0.01);
  assert.equal(so.rows[1].status, "pending");
  assert.equal(so.rows[2].status, "pending");

  // expire check: a pending older than 60 days with no horizon session
  await pool.query(
    `UPDATE signal_outcomes SET created_at = now() - interval '61 days'
      WHERE status='pending' AND horizon_sessions=5`,
  );
  const r2 = await resolveSignalOutcomes(pool);
  assert.equal(r2.expired, 1);
});
