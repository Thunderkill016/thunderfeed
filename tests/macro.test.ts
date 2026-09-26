/* Macro Foundation V1 — regressions.
 *
 * pg-mem verifies portable DDL + vintage-revision semantics. Append-only
 * trigger + RLS are PG-only — asserted against the migration text. */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFredResponse,
  parseFredObservations,
  parseFredSeriesMeta,
} from "../lib/macro";
import {
  applyMacroObservations,
  getOrCreateMacroSeries,
} from "../lib/db/macro";
import { injectPool } from "../lib/db/pool";
import {
  getMacroPointHistory,
  getMacroPoints,
  getMacroSeriesList,
} from "../lib/db/read";

function setupDb(): Pool {
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
    // pg-mem can't run the ALTERs — patch the literals (0023-0027 pattern)
    .replace(
      "'manual_verified', 'other'",
      "'manual_verified', 'alphavantage', 'tiingo', 'fred', 'other'",
    )
    .replace(
      "price_basis IN ('as_traded')",
      "price_basis IN ('as_traded','provider_adjusted')",
    );
  db.public.registerFunction({
    name: "uuid_v7",
    returns: DataType.uuid,
    implementation: () => randomUUID(),
    impure: true,
  });
  db.public.none(sql);
  const pg = db.adapters.createPg();
  const pool = new pg.Pool() as unknown as Pool;
  injectPool(pool);
  return pool;
}

const META = {
  seriess: [
    {
      id: "CPIAUCSL",
      title: "Consumer Price Index for All Urban Consumers",
      frequency: "Monthly",
      frequency_short: "M",
      units: "Index 1982-1984=100",
      seasonal_adjustment: "Seasonally Adjusted",
    },
  ],
};

const OBS = {
  observations: [
    {
      date: "2025-12-01",
      value: "322.560",
      realtime_start: "2026-01-14",
      realtime_end: "9999-12-31",
    },
    {
      date: "2026-01-01",
      value: "323.123",
      realtime_start: "2026-02-11",
      realtime_end: "9999-12-31",
    },
    {
      date: "2026-02-01",
      value: ".",
      realtime_start: "2026-03-11",
      realtime_end: "9999-12-31",
    },
  ],
};

test("parseFredSeriesMeta — real FRED shape", () => {
  const m = parseFredSeriesMeta(META);
  assert.ok(m.kind === "meta");
  assert.equal(m.meta.seriesCode, "CPIAUCSL");
  assert.equal(m.meta.frequencyShort, "M");
  assert.equal(m.meta.units, "Index 1982-1984=100");
  const bad = parseFredSeriesMeta({});
  assert.ok(bad.kind === "error");
});

test("parseFredObservations — decimal strings, '.' skipped, vintage kept", () => {
  const r = parseFredObservations(OBS);
  assert.ok(r.kind === "observations");
  assert.equal(r.observations.length, 2); // '.' never becomes a row
  assert.equal(r.observations[0].value, "322.56"); // normalized decimal string
  assert.equal(r.observations[0].vintageDate, "2026-01-14");
  const err = parseFredObservations({
    observations: [{ date: "x", value: "1", realtime_start: "2026-01-01" }],
  });
  assert.ok(err.kind === "error");
});

test("classifyFredResponse — error_code classes", () => {
  assert.equal(classifyFredResponse(200, { observations: [] }), "ok");
  assert.equal(
    classifyFredResponse(400, {
      error_code: "BAD_REQUEST",
      error_message: "The series does not exist",
    }),
    "invalid_series",
  );
  assert.equal(
    classifyFredResponse(400, {
      error_code: "BAD_REQUEST",
      error_message: "api_key is invalid",
    }),
    "unauthorized",
  );
  assert.equal(
    classifyFredResponse(429, {
      error_code: "THROTTLE",
      error_message: "limit exceeded",
    }),
    "rate_limited",
  );
});

test("macro apply — vintage-aware append-only revisions", async () => {
  const pool = setupDb();
  const obs = await pool.query(
    `INSERT INTO reference_observations (provider,dataset,record_key,payload,content_hash)
     VALUES ('fred','series_observations',$1,'{}',$2) RETURNING id`,
    ["fred:CPIAUCSL", randomUUID()],
  );
  const obsId = obs.rows[0].id as string;
  const metaR = parseFredSeriesMeta(META);
  const seriesId = await getOrCreateMacroSeries(pool, {
    seriesCode: "CPIAUCSL",
    meta: metaR.kind === "meta" ? metaR.meta : undefined,
  });
  const obsR = parseFredObservations(OBS);
  const rows = obsR.kind === "observations" ? obsR.observations : [];
  assert.ok(rows.length > 0);

  // initial ingest
  const r1 = await applyMacroObservations(pool, seriesId, rows, obsId);
  assert.equal(r1.pointsInserted, 2);
  assert.equal(r1.versionsInserted, 2);

  // idempotent rerun — identical (vintage,value) pairs → +0
  const r2 = await applyMacroObservations(pool, seriesId, rows, obsId);
  assert.equal(r2.pointsInserted, 0);
  assert.equal(r2.versionsInserted, 0);
  assert.equal(r2.unchanged, 2);

  // revision: same obs_date, later vintage, corrected value → version+1
  const rev = [
    { obsDate: "2025-12-01", vintageDate: "2026-03-01", value: "322.600" },
  ];
  const r3 = await applyMacroObservations(pool, seriesId, rev, obsId);
  assert.equal(r3.versionsInserted, 1);

  const hist = await getMacroPointHistory(
    "macro_series:fred:CPIAUCSL",
    "2025-12-01",
  );
  assert.equal(hist.length, 2);
  assert.equal(String(hist[0].value), "322.56");
  assert.equal(String(hist[1].value), "322.6"); // latest vintage wins current
  assert.equal(hist[1].versionNo, 2);

  // as-of read: vintage 2026-02-01 sees the pre-revision value
  const asOf = await getMacroPoints("macro_series:fred:CPIAUCSL", {
    asOf: "2026-02-01",
  });
  const dec = asOf.find((p) => p.obsDate === "2025-12-01");
  assert.equal(
    String(dec?.value),
    "322.56",
    "as-of view must show the value official at that vintage",
  );

  const list = await getMacroSeriesList();
  assert.equal(list.length, 1);
  assert.equal(list[0].seriesCode, "CPIAUCSL");
});

test("macro migration text — append-only + RLS + provider allowlist", () => {
  const sql = readFileSync("db/migrations/0027_macro_foundation.sql", "utf8");
  assert.ok(sql.includes("CREATE TABLE macro_series"));
  assert.ok(sql.includes("CREATE TABLE macro_point_versions"));
  assert.ok(sql.includes("vintage_date"));
  assert.ok(
    sql.includes("REVOKE ALL PRIVILEGES ON TABLE") &&
      sql.includes("ENABLE ROW LEVEL SECURITY"),
    "RLS + revoke",
  );
  assert.ok(sql.includes("reject_history_mutation"), "append-only trigger");
  assert.ok(sql.includes("UNIQUE (id, point_id)"), "composite FK target");
  assert.ok(sql.includes("REFERENCES macro_point_versions (id, point_id)"));
  assert.ok(sql.includes("'fred'"), "provider allowlist");
});
