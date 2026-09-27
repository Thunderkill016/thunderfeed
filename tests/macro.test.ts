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
  parseWorldBankObservations,
} from "../lib/macro";
import {
  applyMacroObservations,
  getOrCreateMacroSeries,
} from "../lib/db/macro";
import { injectPool } from "../lib/db/pool";
import {
  getEntityList,
  getEntityMacroSeries,
  getInstrumentList,
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
      "'manual_verified', 'alphavantage', 'tiingo', 'fred', " +
        "'worldbank', 'other'",
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
  // FRED also emits numeric error_code on some endpoints
  assert.equal(
    classifyFredResponse(400, {
      error_code: 400,
      error_message: "Bad Request.  The series does not exist.",
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

  // data_deltas: baseline ingest emits nothing (first load isn't a
  // change), the real revision emits one 'medium' delta
  const deltas = await pool.query(
    `SELECT kind, materiality, summary FROM data_deltas
      ORDER BY detected_at, kind`,
  );
  assert.equal(deltas.rows.length, 1);
  assert.equal(deltas.rows[0].kind, "macro_revision");
  assert.equal(deltas.rows[0].materiality, "medium");
  assert.match(deltas.rows[0].summary as string, /322\.56 → 322\.6/);

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

  // entity wire: series scoped via entity_id surface on the entity page read
  // entity wire: series scoped via entity_id surface on the entity page read
  const ent = await pool.query(
    `INSERT INTO entities (canonical_key, canonical_name, entity_type)
     VALUES ('country:us','United States','country')
     ON CONFLICT (canonical_key) DO NOTHING
     RETURNING id`,
  );
  const entityId =
    (ent.rows[0]?.id as string | undefined) ??
    ((
      await pool.query(
        `SELECT id FROM entities WHERE canonical_key='country:us'`,
      )
    ).rows[0].id as string);
  await pool.query(`UPDATE macro_series SET entity_id=$1`, [entityId]);
  const scoped = await getEntityMacroSeries(entityId);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].seriesCode, "CPIAUCSL");
  assert.equal(String(scoped[0].latestValue), "323.123"); // latest obs_date's current value
  const none = await getEntityMacroSeries(randomUUID());
  assert.equal(none.length, 0);

  // index reads: entity list ranks data-bearing entities first
  const entList = await getEntityList();
  const us = entList.find((e) => e.canonicalKey === "country:us");
  assert.ok(us, "seeded entity must appear");
  assert.equal(us!.macroCount, 1, "CPIAUCSL is linked to country:us");
  assert.equal(
    entList[0].canonicalKey,
    "country:us",
    "data-bearing entity sorts first",
  );
  const instrList = await getInstrumentList();
  assert.ok(Array.isArray(instrList));

  // vintage roll with identical value → version row still written, but
  // NO delta — provenance churn is not a fact-change
  const r5 = await applyMacroObservations(
    pool,
    seriesId,
    [{ obsDate: "2025-12-01", vintageDate: "2026-04-01", value: "322.600" }],
    obsId,
  );
  assert.equal(r5.versionsInserted, 1);
  const d3 = await pool.query(`SELECT count(*) AS n FROM data_deltas`);
  assert.equal(Number(d3.rows[0].n), 1, "vintage-only move must not emit");

  // a new obs_date on a series that exists → release delta, routine 'low'
  // (runs last — it moves the series' latest obs forward)
  const r4 = await applyMacroObservations(
    pool,
    seriesId,
    [{ obsDate: "2026-03-01", vintageDate: "2026-04-10", value: "324.0" }],
    obsId,
  );
  assert.equal(r4.versionsInserted, 1);
  const d2 = await pool.query(
    `SELECT kind, materiality FROM data_deltas ORDER BY detected_at, kind`,
  );
  assert.equal(d2.rows.length, 2);
  assert.equal(d2.rows[1].kind, "macro_release");
  assert.equal(d2.rows[1].materiality, "low");
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

test("parseWorldBankObservations — WB shape, null skipped, year→Jan1", () => {
  const payload = [
    { page: 1, pages: 1, total: 3 },
    [
      {
        indicator: { id: "NY.GDP.MKTP.CD", value: "GDP (current US$)" },
        country: { id: "VN", value: "Vietnam" },
        countryiso3code: "VNM",
        date: "2024",
        value: 465814000000,
      },
      {
        indicator: { id: "NY.GDP.MKTP.CD", value: "GDP (current US$)" },
        country: { id: "VN", value: "Vietnam" },
        countryiso3code: "VNM",
        date: "2023",
        value: 425670000000,
      },
      {
        indicator: { id: "NY.GDP.MKTP.CD", value: "GDP (current US$)" },
        country: { id: "VN", value: "Vietnam" },
        countryiso3code: "VNM",
        date: "2022",
        value: null,
      },
    ],
  ];
  const r = parseWorldBankObservations(payload, "2026-11-24");
  assert.equal(r.kind, "observations");
  if (r.kind !== "observations") return;
  assert.equal(r.observations.length, 2, "null value skipped");
  assert.equal(r.observations[0].obsDate, "2024-01-01");
  assert.equal(r.observations[0].vintageDate, "2026-11-24");
  assert.equal(r.observations[0].value, "465814000000");
  // malformed payload → error, not crash
  assert.equal(parseWorldBankObservations({}, "2026-11-24").kind, "error");
  assert.equal(
    parseWorldBankObservations([{}, []], "2026-11-24").kind,
    "empty",
  );
});

test("stableVintage — unchanged values mint nothing, real change revises", async () => {
  const pool = setupDb();
  const obs = await pool.query(
    `INSERT INTO reference_observations (provider,dataset,record_key,payload,content_hash)
     VALUES ('worldbank','series_observations',$1,'{}',$2) RETURNING id`,
    ["worldbank:VNM:NY.GDP.MKTP.CD", randomUUID()],
  );
  const obsId = obs.rows[0].id as string;
  const seriesId = await getOrCreateMacroSeries(pool, {
    provider: "worldbank",
    seriesCode: "VNM:NY.GDP.MKTP.CD",
  });
  const v1 = [
    { obsDate: "2023-01-01", vintageDate: "2026-11-24", value: "425670000000" },
    { obsDate: "2024-01-01", vintageDate: "2026-11-24", value: "465814000000" },
  ];
  const r1 = await applyMacroObservations(pool, seriesId, v1, obsId, {
    stableVintage: true,
  });
  assert.equal(r1.versionsInserted, 2);

  // rerun next fetch-day: identical values, new synthetic vintage → +0
  // (without stableVintage this would mint 2 churn versions)
  const v2 = v1.map((o) => ({ ...o, vintageDate: "2026-12-01" }));
  const r2 = await applyMacroObservations(pool, seriesId, v2, obsId, {
    stableVintage: true,
  });
  assert.equal(r2.versionsInserted, 0);
  assert.equal(r2.unchanged, 2);

  // WB revises 2024 → new version + macro_revision delta (value moved)
  const v3 = [
    { obsDate: "2024-01-01", vintageDate: "2027-03-01", value: "470100000000" },
  ];
  const r3 = await applyMacroObservations(pool, seriesId, v3, obsId, {
    stableVintage: true,
  });
  assert.equal(r3.versionsInserted, 1);
  const deltas = await pool.query(
    `SELECT kind, materiality, summary FROM data_deltas`,
  );
  assert.equal(deltas.rows.length, 1);
  assert.equal(deltas.rows[0].kind, "macro_revision");
  assert.match(
    deltas.rows[0].summary as string,
    /VNM:NY\.GDP\.MKTP\.CD kỳ 2024-01-01/,
  );
});
