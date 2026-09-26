/* Corporate Actions V1 — regressions.
 *
 * pg-mem verifies portable DDL, reconciliation semantics and identity
 * rules. Append-only triggers + RLS are PG-only — asserted against the
 * migration text (same technique as instruments/market tests). */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDailyBars,
  getOrCreateTiingoAdjustedSeries,
  getOrCreateTiingoEodSeries,
} from "../lib/db/market";
import { applyActionAssertion } from "../lib/db/corporate-actions";
import {
  caFingerprint,
  parseAlphaDividends,
  parseAlphaSplits,
  parseTiingoDistributions,
  parseTiingoSplits,
  tiingoHintToSemantics,
} from "../lib/corporate-actions";
import { parseTiingoEod } from "../lib/market";
import { injectPool } from "../lib/db/pool";
import {
  getCorporateAction,
  getCorporateActionsForInstrument,
  getCorporateActionsForListing,
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
    // pg-mem can't run the 0023/0025/0026 ALTERs — patch the literals
    .replace(
      "'manual_verified', 'other'",
      "'manual_verified', 'alphavantage', 'tiingo', 'other'",
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

async function fixtureInstrument(pool: Pool, key: string) {
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
  const v = await pool.query(
    `INSERT INTO trading_venues (mic) VALUES ('XNGS')
     ON CONFLICT (mic) DO NOTHING RETURNING id`,
  );
  const venueId =
    (v.rows[0]?.id as string | undefined) ??
    ((await pool.query(`SELECT id FROM trading_venues WHERE mic='XNGS'`))
      .rows[0].id as string);
  const l = await pool.query(
    `INSERT INTO instrument_listings (canonical_key, instrument_id, venue_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [`listing:${key}`, fi.rows[0].id, venueId],
  );
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, observation_id)
     VALUES ($1,1,'ABC','active',$2) RETURNING id`,
    [l.rows[0].id, obs.rows[0].id],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, l.rows[0].id],
  );
  return {
    instrumentId: fi.rows[0].id as string,
    listingId: l.rows[0].id as string,
    listingKey: `listing:${key}` as string,
  };
}

async function obsRow(pool: Pool, tag: string, payload: unknown = {}) {
  const r = await pool.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, payload, content_hash)
     VALUES ('manual_verified','ca_fixture',$1,$2,$1) RETURNING id`,
    [`obs:${tag}:${randomUUID()}`, JSON.stringify(payload)],
  );
  return r.rows[0].id as string;
}

const base = (instrumentId: string, listingId: string, obsId: string) => ({
  instrumentId,
  sourceListingId: listingId,
  provider: "alphavantage",
  dataset: "dividends",
  providerRecordKey: "ABC:dividends:2026-06-01",
  actionType: "cash_dividend" as const,
  exDate: "2026-06-01",
  observationId: obsId,
});

// ── parsers ──────────────────────────────────────────────────────────────

test("parseAlphaDividends: preserves provider fields, missing dates NULL", () => {
  const r = parseAlphaDividends({
    symbol: "ABC",
    data: [
      {
        ex_dividend_date: "2026-06-01",
        declaration_date: "2026-05-01",
        record_date: "2026-06-03",
        payment_date: "2026-06-15",
        amount: "0.25",
      },
      { ex_dividend_date: "2026-03-02", amount: "0.25" },
    ],
  });
  assert.ok(r.kind === "actions");
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].cashAmount, "0.25");
  assert.equal(r.actions[0].paymentDate, "2026-06-15");
  assert.equal(r.actions[1].paymentDate, null); // absent stays NULL
  assert.equal(r.meta.symbol, "ABC");
});

test("parseAlphaSplits: effective_date is the ex-date, no invented ratio parts", () => {
  const r = parseAlphaSplits({
    symbol: "ABC",
    data: [{ effective_date: "2020-08-31", split_factor: "4.0000" }],
  });
  assert.ok(r.kind === "actions");
  assert.equal(r.actions[0].exDate, "2020-08-31");
  assert.equal(r.actions[0].splitFactor, "4.0000");
  assert.equal(r.actions[0].splitFrom, undefined); // never decomposed
  assert.equal(r.actions[0].splitTo, undefined);
});

test("parseAlphaDividends: rate-limit note is provider_error, not empty success", () => {
  const r = parseAlphaDividends({ Note: "rate limit" });
  assert.ok(r.kind === "provider_error");
  assert.equal(r.errorClass, "rate_limit");
});

test("parseTiingoDistributions/Splits: documented field names, status preserved", () => {
  const d = parseTiingoDistributions([
    {
      exDate: "2026-06-01",
      distribution: 0.25,
      paymentDate: "2026-06-15",
      recordDate: "2026-06-03",
      declarationDate: "2026-05-01",
    },
    {
      exDate: "2026-09-01",
      distribution: 0.25,
      distributionStatus: "cancelled",
    },
  ]);
  assert.ok(d.kind === "actions");
  assert.equal(d.actions[0].cashAmount, "0.25");
  assert.equal(d.actions[0].paymentDate, "2026-06-15");
  assert.equal(d.actions[1].providerStatus, "cancelled");

  const s = parseTiingoSplits([
    {
      exDate: "2020-08-31",
      splitFrom: "1",
      splitTo: "4",
      splitFactor: "4",
      splitStatus: "completed",
    },
  ]);
  assert.ok(s.kind === "actions");
  assert.equal(s.actions[0].splitFactor, "4");
  assert.equal(s.actions[0].splitTo, "4");
});

test("tiingoHintToSemantics: divCash≠0 → dividend, splitFactor≠1 → split, 0/1/garbage → none", () => {
  assert.equal(
    tiingoHintToSemantics({ exDate: "d", divCash: "0.27", splitFactor: "1" })[0]
      .type,
    "cash_dividend",
  );
  assert.equal(
    tiingoHintToSemantics({ exDate: "d", divCash: "0", splitFactor: "4" })[0]
      .type,
    "stock_split",
  );
  assert.equal(
    tiingoHintToSemantics({ exDate: "d", divCash: "0", splitFactor: "1" })
      .length,
    0,
  );
  assert.equal(
    tiingoHintToSemantics({ exDate: "d", divCash: "abc", splitFactor: "x" })
      .length,
    0,
  );
});

// ── apply layer — mandatory regressions ──────────────────────────────────

test("dividend correction: same action, assertion +1, version +1", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca1");
  const o1 = await obsRow(pool, "d1", { amount: "0.25" });
  const r1 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
    currency: "USD",
  });
  assert.equal(r1.outcome, "asserted");
  assert.equal(r1.versionNo, 1);

  // provider corrects the same record: same record key, new observation,
  // new amount — old assertion MUST remain, canonical version bumps
  const o2 = await obsRow(pool, "d2", { amount: "0.27" });
  const r2 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o2),
    cashAmount: "0.27",
    currency: "USD",
  });
  assert.equal(r2.outcome, "corrected");
  assert.equal(r2.actionId, r1.actionId);
  assert.equal(r2.versionNo, 2);
  assert.notEqual(r2.assertionId, r1.assertionId);

  const view = await getCorporateAction(r1.actionId!);
  assert.equal(view!.assertions.length, 2); // both provider truths kept
  assert.equal(view!.currentVersion!.cashAmount, "0.27");
  assert.equal(view!.currentVersion!.versionNo, 2);
  const roles = view!.derivations.map((d) => d.role);
  assert.ok(roles.includes("asserts"));
  assert.ok(roles.includes("conflicts")); // the old 0.25 claim now conflicts
});

test("split correction: same ex-date, factor correction → version +1", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca2");
  const o1 = await obsRow(pool, "s1");
  const r1 = await applyActionAssertion(pool, {
    instrumentId,
    sourceListingId: listingId,
    provider: "alphavantage",
    dataset: "splits",
    providerRecordKey: "ABC:splits:2020-08-31",
    actionType: "stock_split",
    exDate: "2020-08-31",
    splitFactor: "4.0000",
    observationId: o1,
  });
  assert.equal(r1.outcome, "asserted");
  const o2 = await obsRow(pool, "s2");
  const r2 = await applyActionAssertion(pool, {
    instrumentId,
    sourceListingId: listingId,
    provider: "alphavantage",
    dataset: "splits",
    providerRecordKey: "ABC:splits:2020-08-31",
    actionType: "stock_split",
    exDate: "2020-08-31",
    splitFactor: "4.5",
    observationId: o2,
  });
  assert.equal(r2.outcome, "corrected");
  assert.equal(r2.actionId, r1.actionId);
  assert.equal(r2.versionNo, 2);
  const view = await getCorporateAction(r1.actionId!);
  assert.equal(view!.currentVersion!.splitFactor, "4.5");
});

test("cancellation: active → cancelled is a versioned transition, history retained", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca3");
  const o1 = await obsRow(pool, "c1");
  const r1 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
  });
  const o2 = await obsRow(pool, "c2");
  const r2 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o2),
    cashAmount: "0.25",
    providerStatus: "cancelled",
  });
  assert.equal(r2.outcome, "corrected");
  assert.equal(r2.versionNo, 2);
  const view = await getCorporateAction(r1.actionId!);
  assert.equal(view!.status, "cancelled");
  assert.equal(view!.currentVersion!.status, "cancelled");
  // v1 history retained — never deleted
  const hist = await pool.query(
    `SELECT count(*) n FROM corporate_action_versions WHERE action_id=$1`,
    [r1.actionId],
  );
  assert.equal(Number(hist.rows[0].n), 2);
});

test("provider disagreement: alpha 0.25 vs tiingo 0.27 → divergence, no average", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca4");
  const o1 = await obsRow(pool, "x1");
  const r1 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
  });
  const o2 = await obsRow(pool, "x2");
  const r2 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o2),
    provider: "tiingo",
    dataset: "corporate_actions_distributions",
    providerRecordKey: "ABC:distributions:2026-06-01",
    cashAmount: "0.27",
  });
  // different provider, same canonical rank → disagreement is RECORDED,
  // canonical untouched, nothing averaged
  assert.equal(r2.outcome, "conflicted");
  assert.equal(r2.actionId, r1.actionId);
  const view = await getCorporateAction(r1.actionId!);
  assert.equal(view!.currentVersion!.cashAmount, "0.25");
  assert.equal(view!.currentVersion!.versionNo, 1);
  assert.equal(view!.agreement.state, "divergence");
  assert.ok(view!.agreement.divergentFields.includes("cashAmount"));
  assert.equal(view!.assertions.length, 2);
  assert.ok(view!.derivations.some((d) => d.role === "conflicts"));
});

test("duplicate rerun: identical provider assertion → +0", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca5");
  const o1 = await obsRow(pool, "dup1");
  const input = {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
  };
  const r1 = await applyActionAssertion(pool, input);
  const r2 = await applyActionAssertion(pool, input); // identical
  assert.equal(r2.outcome, "deduped");
  const counts = await pool.query(
    `SELECT
       (SELECT count(*) FROM corporate_actions) a,
       (SELECT count(*) FROM corporate_action_versions) v,
       (SELECT count(*) FROM corporate_action_assertions) s`,
  );
  assert.equal(Number(counts.rows[0].a), 1);
  assert.equal(Number(counts.rows[0].v), 1);
  assert.equal(Number(counts.rows[0].s), 1);
  void r1;
});

test("fingerprint: decimal forms agree — '0.25' ≡ '0.2500'", () => {
  const a = caFingerprint({ exDate: "d", cashAmount: "0.25" });
  const b = caFingerprint({ exDate: "d", cashAmount: "0.2500" });
  const c = caFingerprint({ exDate: "d", cashAmount: "0.27" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("ticker rename: actions stay attached to instrument_id", async () => {
  const pool = setupDb();
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca6");
  const o1 = await obsRow(pool, "rn1");
  const r1 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
  });
  // ticker rename = new listing version; the listing id survives
  const obs2 = await obsRow(pool, "rn2");
  const lv = await pool.query(
    `INSERT INTO listing_versions
       (listing_id, version_no, ticker, status, observation_id)
     VALUES ($1,2,'NEWTK','active',$2) RETURNING id`,
    [listingId, obs2],
  );
  await pool.query(
    `UPDATE instrument_listings SET current_version_id=$1 WHERE id=$2`,
    [lv.rows[0].id, listingId],
  );
  const byListing = await getCorporateActionsForListing(`listing:ca6`);
  assert.equal(byListing.length, 1);
  assert.equal(byListing[0].id, r1.actionId);
  assert.equal(byListing[0].instrumentId, instrumentId);
  const byInstrument = await getCorporateActionsForInstrument("instrument:ca6");
  assert.equal(byInstrument[0].id, r1.actionId);
});

// ── adjusted series quarantine + shared provenance ───────────────────────

test("adjusted quarantine: raw close ≠ adjClose → two separate series, same observation", async () => {
  const pool = setupDb();
  const { listingId, listingKey } = await fixtureInstrument(pool, "ca7");

  const csv = [
    "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor",
    "2026-09-24,100,101,99,100,5000,99.5,100.5,98.5,99.5,5000,0,1",
    "2026-09-25,101,102,100,101,6000,100.0,101.0,99.0,100.0,6000,0.27,1",
    "",
  ].join("\n");
  const parsed = parseTiingoEod({ status: 200, body: csv });
  assert.ok(parsed.kind === "series");
  assert.equal(parsed.bars.length, 2);
  assert.ok(parsed.adjustedBars);
  assert.equal(parsed.actionHints.length, 1);
  assert.equal(parsed.actionHints[0].exDate, "2026-09-25");
  assert.equal(parsed.actionHints[0].divCash, "0.27");

  const obsId = await obsRow(pool, "eod-csv", { csv });
  const rawSeries = await getOrCreateTiingoEodSeries(
    pool,
    listingId,
    listingKey,
  );
  const adjSeries = await getOrCreateTiingoAdjustedSeries(
    pool,
    listingId,
    listingKey,
  );
  assert.notEqual(rawSeries, adjSeries);

  const rRaw = await applyDailyBars(pool, rawSeries, parsed.bars, obsId);
  const rAdj = await applyDailyBars(
    pool,
    adjSeries,
    parsed.adjustedBars!,
    obsId,
  );
  assert.equal(rRaw.pointsInserted, 2);
  assert.equal(rAdj.pointsInserted, 2);

  // raw series carries raw close; adjusted series carries adjClose —
  // they NEVER merge
  const raw = await pool.query(
    `SELECT v.close FROM market_points mp
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE mp.series_id=$1 AND mp.session_date='2026-09-25'`,
    [rawSeries],
  );
  const adj = await pool.query(
    `SELECT v.close FROM market_points mp
       JOIN market_point_versions v ON v.id = mp.current_version_id
      WHERE mp.series_id=$1 AND mp.session_date='2026-09-25'`,
    [adjSeries],
  );
  assert.equal(String(raw.rows[0].close), "101");
  assert.equal(String(adj.rows[0].close), "100"); // pg-mem numeric → 100.0-ish; compare via normalize

  // SAME raw provenance: raw version, adjusted version AND the CA
  // assertion all reference the ONE observation
  const { instrumentId } = await fixtureInstrumentReady(pool, listingId);
  for (const { type, s } of tiingoHintToSemantics(parsed.actionHints[0])) {
    await applyActionAssertion(pool, {
      instrumentId,
      sourceListingId: listingId,
      provider: "tiingo",
      dataset: "eod_daily",
      providerRecordKey: `ABC:eod:${s.exDate}:${type}`,
      actionType: type,
      ...s,
      observationId: obsId,
    });
  }
  const prov = await pool.query(
    `SELECT
       (SELECT count(*) FROM market_point_versions WHERE observation_id=$1) mv,
       (SELECT count(DISTINCT mp.series_id) FROM market_point_versions v
          JOIN market_points mp ON mp.id = v.point_id
         WHERE v.observation_id=$1) ser,
       (SELECT count(*) FROM corporate_action_assertions WHERE observation_id=$1) ca`,
    [obsId],
  );
  assert.equal(Number(prov.rows[0].mv), 4); // raw+adj × 2 days
  assert.equal(Number(prov.rows[0].ser), 2); // both series share the obs
  assert.equal(Number(prov.rows[0].ca), 1); // dividend assertion same obs
});

async function fixtureInstrumentReady(pool: Pool, listingId: string) {
  const r = await pool.query(
    `SELECT instrument_id FROM instrument_listings WHERE id=$1`,
    [listingId],
  );
  return { instrumentId: r.rows[0].instrument_id as string };
}

test("EOD action hints: malformed divCash/splitFactor never become hints", () => {
  const csv = [
    "date,close,high,low,open,volume,adjClose,adjHigh,adjLow,adjOpen,adjVolume,divCash,splitFactor",
    "2026-09-24,100,101,99,100,5000,99.5,100.5,98.5,99.5,5000,,1",
    "2026-09-25,101,102,100,101,6000,100,101,99,100,6000,0,1",
    "2026-09-26,102,103,101,102,7000,101,102,100,101,7000,garbage,2x",
    "",
  ].join("\n");
  const parsed = parseTiingoEod({ status: 200, body: csv });
  assert.ok(parsed.kind === "series");
  assert.equal(parsed.actionHints.length, 0); // 'garbage'/'2x' rejected
});

// ── migration declaration checks (PG-only invariants asserted on text) ────

test("migration 0026 declares append-only triggers, RLS, revoked grants, composite FKs", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../db/migrations/0026_corporate_actions.sql", import.meta.url),
    ),
    "utf8",
  );
  for (const t of [
    "corporate_actions",
    "corporate_action_versions",
    "corporate_action_assertions",
    "corporate_action_derivations",
  ]) {
    assert.ok(sql.includes(`CREATE TABLE ${t}`), `${t} created`);
    assert.ok(
      sql.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`),
      `${t} RLS`,
    );
    assert.ok(
      sql.includes(`REVOKE ALL PRIVILEGES ON TABLE ${t}`),
      `${t} revoke`,
    );
  }
  for (const t of [
    "corporate_action_versions",
    "corporate_action_assertions",
    "corporate_action_derivations",
  ])
    assert.ok(
      sql.includes(`BEFORE UPDATE OR DELETE ON ${t}`),
      `${t} append-only trigger`,
    );
  assert.ok(sql.includes("UNIQUE (id, action_id)"), "composite FK target");
  assert.ok(
    sql.includes("REFERENCES corporate_action_versions (id, action_id)"),
  );
  assert.ok(
    sql.includes("CHECK (price_basis IN ('as_traded','provider_adjusted'))"),
    "provider_adjusted price_basis",
  );
});

test("0026 tables exist on pg-mem with the portable shape", async () => {
  const pool = setupDb();
  for (const t of [
    "corporate_actions",
    "corporate_action_versions",
    "corporate_action_assertions",
    "corporate_action_derivations",
  ]) {
    const r = await pool.query(`SELECT count(*) n FROM ${t}`);
    assert.equal(Number(r.rows[0].n), 0);
  }
  // current-version pointer FK must reject a version of ANOTHER action
  const { instrumentId, listingId } = await fixtureInstrument(pool, "ca8");
  const o1 = await obsRow(pool, "fk1");
  const a1 = await applyActionAssertion(pool, {
    ...base(instrumentId, listingId, o1),
    cashAmount: "0.25",
  });
  const { instrumentId: i2, listingId: l2 } = await fixtureInstrument(
    pool,
    "ca9",
  );
  const o2 = await obsRow(pool, "fk2");
  const a2 = await applyActionAssertion(pool, {
    instrumentId: i2,
    sourceListingId: l2,
    provider: "alphavantage",
    dataset: "dividends",
    providerRecordKey: "ABC:dividends:2026-07-01",
    actionType: "cash_dividend",
    exDate: "2026-07-01",
    cashAmount: "0.10",
    observationId: o2,
  });
  const v2 = await pool.query(
    `SELECT id FROM corporate_action_versions WHERE action_id=$1`,
    [a2.actionId],
  );
  await assert.rejects(
    pool.query(
      `UPDATE corporate_actions SET current_version_id=$1 WHERE id=$2`,
      [v2.rows[0].id, a1.actionId],
    ),
  );
});
