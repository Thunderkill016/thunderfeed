/* R7.0 materiality baseline — rule tests over the frozen rubric.
 * These pin the invariants the engine must keep: honest unknown, no
 * article-count inflation, no beat/miss without consensus data, no
 * market-direction or causal claims from a price move. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  asOfSeriesHistory,
  classifyMacroSeries,
  scoreCorporateAction,
  scoreEventMateriality,
  scoreMacroDelta,
  scoreMarketMove,
  transformSeries,
} from "../lib/materiality";

const ev = (
  predicates: string[],
  extra: Partial<Parameters<typeof scoreEventMateriality>[0]> = {},
) =>
  scoreEventMateriality({
    predicates,
    entities: [],
    topic: "world",
    ...extra,
  });

test("no mapped predicate on ambiguous event → unknown, never forced", () => {
  const a = ev(["money_usd", "visit_duration", "meeting"]);
  assert.equal(a.materiality, "unknown");
  assert.deepEqual(a.channels, []);
});

test("clearly non-economic (casualty predicates only) → none", () => {
  assert.equal(ev(["deaths", "injured", "match_result"]).materiality, "none");
});

test("sports topic → none even with money predicates", () => {
  assert.equal(ev(["money_usd"], { topic: "sports" }).materiality, "none");
});

test("5 spellings of one tariff claim are ONE family — not major", () => {
  const a = ev([
    "tariff_cut",
    "tariff_cut_value",
    "tariff_reduction",
    "tariff_reduction_value",
    "tariff_agreement",
  ]);
  assert.equal(a.materiality, "meaningful");
});

test("two distinct instrument families + funding channel → major", () => {
  const a = ev(["interest_rate", "sanctions", "sanctions", "sanctions"]);
  assert.equal(a.materiality, "major");
  assert.ok(a.channels.includes("discounting"));
});

test("war aid disbursement noise cannot reach major", () => {
  const a = ev([
    "military_aid_disbursement",
    "aid_disbursement",
    "fund_disbursement",
    "debt_to_gdp",
    "deaths",
    "missile_attacks",
    "uav_attacks",
    "ceasefire_proposal",
  ]);
  assert.equal(a.materiality, "limited");
});

test("war context caps sanctions-only claims at meaningful", () => {
  const a = ev(["sanctions", "deaths", "uav_attacks", "missile_attack"]);
  assert.equal(a.materiality, "meaningful");
});

test("a real discounting channel escapes the war cap", () => {
  const a = ev(["interest_rate", "deaths", "missile_attack"]);
  assert.equal(a.materiality, "major"); // rate decision amid war coverage
});

test("lone-company event is issuer-scoped", () => {
  const a = ev(["foreign_direct_investment"], {
    entities: [{ slug: "vinfast", type: "company" }],
    topic: "vietnam",
  });
  assert.equal(a.scope, "issuer");
  assert.equal(a.materiality, "meaningful");
});

test("empty predicates → unknown", () => {
  assert.equal(ev([]).materiality, "unknown");
});

const hist = (base: number, n = 40, jitter = 0.01) =>
  Array.from({ length: n }, (_, i) => base + Math.sin(i) * jitter * base);

const macro = (over: Partial<Parameters<typeof scoreMacroDelta>[0]>) =>
  scoreMacroDelta({
    provider: "fred",
    seriesCode: "CPIAUCSL",
    frequency: "M",
    kind: "macro_release",
    value: 334,
    prevValue: 332,
    history: hist(330),
    ...over,
  });

test("annual IMF/WB forecast → baseline context, not a signal", () => {
  const a = macro({
    provider: "imf",
    seriesCode: "VNM:NGDP_RPCH",
    frequency: "A",
    value: 6.5,
    prevValue: null,
    history: hist(6),
  });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("annual_forecast_baseline"));
  assert.equal(a.scope, "vietnam");
});

test("no consensus data → never a beat/miss claim", () => {
  const a = macro({});
  assert.doesNotMatch(a.reason, /beat|miss|expect/i);
  assert.notEqual(a.materiality, "unknown");
});

test("abnormal core print (|z|≥2.5) → major", () => {
  const a = macro({
    seriesCode: "DGS10",
    frequency: "D",
    value: 6.0,
    prevValue: 5.2,
    history: hist(4.5, 40, 0.02),
  });
  assert.equal(a.materiality, "major");
  assert.deepEqual(a.channels, ["discounting"]);
});

test("official decision instrument step (ECBDFR) → major decision", () => {
  const a = macro({
    seriesCode: "ECBDFR",
    value: 4.0,
    prevValue: 3.75,
    history: hist(3.5),
  });
  assert.equal(a.materiality, "major");
  assert.equal(a.directness, "direct");
  assert.match(a.reason, /policy rate step/);
});

test("FEDFUNDS is an effective rate — a step is abnormal, not a 'decision'", () => {
  assert.equal(classifyMacroSeries("fred", "FEDFUNDS").role, "effective");
  assert.equal(classifyMacroSeries("fred", "ECBDFR").role, "decision");
  const a = macro({
    seriesCode: "FEDFUNDS",
    value: 4.0,
    prevValue: 3.75,
    history: hist(3.5),
  });
  /* a 25bp jump in the effective rate IS abnormal — but the reason must
   * never call it a policy decision without a decision instrument */
  assert.equal(a.materiality, "major");
  assert.doesNotMatch(a.reason, /policy rate step/);
});

test("insufficient history → limited + insufficient_history caution", () => {
  const a = macro({
    seriesCode: "VIXCLS",
    frequency: "D",
    value: 30,
    prevValue: 20,
    history: [15, 16],
  });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("insufficient_history"));
});

test("revision never exceeds meaningful", () => {
  const a = macro({
    seriesCode: "GDPC1",
    frequency: "Q",
    kind: "macro_revision",
    value: 999,
    prevValue: 100,
    history: hist(100),
  });
  assert.equal(a.materiality, "meaningful");
  assert.ok(a.cautions.includes("revision"));
});

const ca = (amt: number, extra = {}) =>
  scoreCorporateAction({
    actionType: "cash_dividend",
    instrumentKey: "equity:HOSE:VNM",
    cashAmount: amt,
    currency: "USD",
    referencePrice: 100,
    priceBasis: "pre_ex",
    priceConvention: "as_traded",
    priceCurrency: "USD",
    exDate: "2026-03-01T00:00:00Z",
    splitFactor: null,
    ...extra,
  });

test("tiny dividend → limited; big yield → meaningful", () => {
  assert.equal(ca(0.1).materiality, "limited");
  assert.equal(ca(6).materiality, "meaningful");
});

test("no price context → limited + caution", () => {
  const a = ca(5, { referencePrice: null, priceBasis: "none" });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("no_price_context"));
});

test("look-ahead price basis → yield unverifiable, flagged", () => {
  const a = ca(6, { priceBasis: "latest" });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("lookahead_price"));
});

test("provider-magnitude anomaly ($567 'dividend') → flagged + limited", () => {
  const a = ca(567.97, { referencePrice: 90 });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("provider_magnitude_unverified"));
});

test("provider_adjusted price → yield unverifiable, capped", () => {
  const a = ca(6, { priceConvention: "provider_adjusted" });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("price_convention_unverified"));
});

test("unknown currency on either side → no yield upgrade", () => {
  const a = ca(6, { currency: null, priceCurrency: "USD" });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("currency_unverified"));
  const b = ca(6, { priceCurrency: null });
  assert.equal(b.materiality, "limited");
  assert.ok(b.cautions.includes("currency_unverified"));
  const c = ca(6, { currency: "VND", priceCurrency: "USD" });
  assert.equal(c.materiality, "limited");
  assert.ok(c.cautions.includes("currency_mismatch"));
});

test("split is mechanical — no channel, limited", () => {
  const a = scoreCorporateAction({
    actionType: "stock_split",
    instrumentKey: "equity:NGS:AAPL",
    cashAmount: null,
    currency: null,
    referencePrice: 341,
    priceBasis: "pre_ex",
    priceConvention: "as_traded",
    priceCurrency: "USD",
    exDate: "2020-08-31T00:00:00Z",
    splitFactor: 4,
  });
  assert.equal(a.materiality, "limited");
  assert.deepEqual(a.channels, []);
});

const mv = (pct: number, vol: number | null, extra = {}) =>
  scoreMarketMove({
    instrumentKey: "equity:HOSE:VPB",
    assetClass: "equity",
    pctChange: pct,
    trailingVol: vol,
    isIndex: false,
    ...extra,
  });

test("a move proves reaction, never cause — channels stay empty", () => {
  const a = mv(4, 1.8);
  assert.deepEqual(a.channels, []);
  assert.ok(a.cautions.includes("reaction_not_cause"));
  assert.equal(a.transmissionConfidence, null);
});

test("extreme z on single stock → meaningful; routine → limited/none", () => {
  assert.equal(mv(9, 1.8).materiality, "meaningful"); // z=5
  assert.equal(mv(4.5, 1.8).materiality, "limited"); // z=2.5 equity
  assert.equal(mv(1, 1.8).materiality, "limited");
  assert.equal(mv(0.5, null).materiality, "none");
});

test("index move carries wider scope", () => {
  const a = mv(3, 1, {
    isIndex: true,
    assetClass: "index",
    instrumentKey: "index:NGS:SPX",
  });
  assert.equal(a.materiality, "meaningful");
  assert.equal(a.scope, "global_systemic");
});

test("VN30: asset_class='equity' + isIndex → scope=vietnam, never issuer", () => {
  const a = mv(3, 1, {
    isIndex: true,
    assetClass: "equity", // prod stores indexes as equity+index type
    instrumentKey: "index:HOSE:VN30",
  });
  assert.equal(a.scope, "vietnam");
  assert.equal(a.materiality, "meaningful");
});

test("wire-copy count cannot inflate — scorer has no such input", () => {
  const base = {
    predicates: ["sanctions", "interest_rate"],
    entities: [] as { slug: string; type: string }[],
    topic: "world",
  };
  const bare = scoreEventMateriality(base);
  const inflated = scoreEventMateriality({
    ...base,
    /* pretend 500 outlets carried it — extra keys are ignored */
    ...({ outletCount: 500, evidenceCount: 500 } as object),
  } as Parameters<typeof scoreEventMateriality>[0]);
  assert.deepEqual(inflated, bare);
});

test("series classification separates VN scope from global", () => {
  assert.equal(classifyMacroSeries("imf", "VNM:PCPIPCH").scope, "vietnam");
  assert.equal(
    classifyMacroSeries("imf", "USA:PCPIPCH").scope,
    "global_systemic",
  );
  assert.equal(classifyMacroSeries("fred", "DGS10").salience, "core");
  assert.equal(
    classifyMacroSeries("worldbank", "VNM:NY.GDP.MKTP.KD.ZG").salience,
    "baseline",
  );
  assert.equal(classifyMacroSeries("fred", "CPIAUCSL").measure, "level_index");
  assert.equal(classifyMacroSeries("fred", "PAYEMS").measure, "stock");
  assert.equal(classifyMacroSeries("fred", "DGS10").measure, "rate_pct");
});

/* ── R7.0b semantics hardening ─────────────────────────────── */

test("transform semantics: declared per series — diff vs pct-change", () => {
  const rate = transformSeries("diff", 4.5, [4.0, 4.25]);
  assert.equal(rate!.transform, "diff");
  assert.equal(rate!.observed, 0.25);
  assert.deepEqual(rate!.basis, [0.25]);
  const cpi = transformSeries("pct_change", 104, [100, 102]);
  assert.equal(cpi!.transform, "pct_change");
  assert.ok(Math.abs(cpi!.observed - (2 / 102) * 100) < 1e-9);
  assert.ok(Math.abs(cpi!.basis[0] - 2) < 1e-9);
});

test("a trending LEVEL is not abnormal — CPI 21→334 trend ≠ surprise", () => {
  /* 40 noisy rising CPI levels: value continues the same trend. Raw
   * level z would be enormous; change-space z is ~0. */
  const trend = Array.from(
    { length: 40 },
    (_, i) => 300 + i * 0.85 + Math.sin(i * 2.3) * 0.9,
  );
  const a = macro({
    seriesCode: "CPIAUCSL",
    value: 300 + 40 * 0.85 + Math.sin(40 * 2.3) * 0.9, // on-trend print
    prevValue: trend[39],
    history: trend,
  });
  assert.equal(a.materiality, "limited");
});

test("a genuinely abnormal CPI change still fires", () => {
  const trend = Array.from(
    { length: 40 },
    (_, i) => 300 + i * 0.85 + Math.sin(i * 2.3) * 0.9,
  );
  const a = macro({
    seriesCode: "CPIAUCSL",
    value: 300 + 40 * 0.85 + 9, // +2.7% MoM vs ~0.3% prints
    prevValue: trend[39],
    history: trend,
  });
  assert.equal(a.materiality, "major");
});

test("payroll LEVEL (159M) is not abnormal — only the Δ is measured", () => {
  const trend = Array.from(
    { length: 40 },
    (_, i) => 155000 + i * 200 + Math.sin(i * 1.7) * 900,
  );
  const a = macro({
    seriesCode: "PAYEMS",
    value: trend[39] + 210,
    prevValue: trend[39],
    history: trend,
  });
  assert.equal(a.materiality, "limited");
});

test("PAYEMS transform is Δ jobs (diff), not %Δ of the stock", () => {
  assert.equal(classifyMacroSeries("fred", "PAYEMS").transform, "diff");
  const tr = transformSeries("diff", 159200, [158000, 159000]);
  /* +200 jobs — NOT +0.126%. A payroll print is a flow of new jobs. */
  assert.equal(tr!.observed, 200);
  assert.deepEqual(tr!.basis, [1000]);
});

test("PCEPILFE is a registered core inflation series", () => {
  const m = classifyMacroSeries("fred", "PCEPILFE");
  assert.equal(m.cls, "inflation");
  assert.equal(m.salience, "core");
  assert.deepEqual(
    ["discounting", "fundamental"].every((c) =>
      scoreMacroDelta({
        provider: "fred",
        seriesCode: "PCEPILFE",
        frequency: "M",
        kind: "macro_release",
        value: 1,
        prevValue: 1,
        history: [],
      }).channels.includes(c as "discounting"),
    ),
    true,
  );
});

test("as-of history: later revisions NEVER leak into a vintage-T score", () => {
  /* vintage T sees values [10, 20, 30]. A backfill lands at T+30
   * revising the middle print to 99 — the T score's baseline must not
   * contain it. */
  const rows = [
    { obsDate: "2025-01-01", vintageDate: "2025-01-15", value: 10 },
    { obsDate: "2025-02-01", vintageDate: "2025-02-15", value: 20 },
    { obsDate: "2025-02-01", vintageDate: "2025-03-25", value: 99 },
    { obsDate: "2025-03-01", vintageDate: "2025-03-15", value: 30 },
    { obsDate: "2025-04-01", vintageDate: "2025-04-15", value: 40 },
  ];
  assert.deepEqual(
    asOfSeriesHistory(rows, "2025-04-01", "2025-04-15"),
    [10, 99, 30],
  );
  /* scoring the 2025-03-01 print as known at its own vintage: the 99
   * revision (vintage 03-25 > target vintage 03-15) is excluded */
  assert.deepEqual(
    asOfSeriesHistory(rows, "2025-03-01", "2025-03-15"),
    [10, 20],
  );
  /* observations after the target obs never enter the baseline either */
  assert.deepEqual(asOfSeriesHistory(rows, "2025-02-01", "2025-02-15"), [10]);
});

test("typed targets: country entity → country_exposure, never bare slug", () => {
  const a = ev(["sanctions", "tariff_cut"], {
    entities: [
      { slug: "us", type: "country" },
      { slug: "vietnam", type: "country" },
      { slug: "vinfast", type: "company" },
    ],
  });
  assert.deepEqual(a.affectedTargets, [
    { type: "country_exposure", key: "us" },
    { type: "country_exposure", key: "vietnam" },
  ]);
});

test("no channels → no targets (mention ≠ exposure)", () => {
  const a = ev(["money_usd", "meeting"], {
    entities: [{ slug: "us", type: "country" }],
  });
  assert.deepEqual(a.affectedTargets, []);
});
