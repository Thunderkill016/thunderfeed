/* R7.0 materiality baseline — rule tests over the frozen rubric.
 * These pin the invariants the engine must keep: honest unknown, no
 * article-count inflation, no beat/miss without consensus data, no
 * market-direction or causal claims from a price move. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMacroSeries,
  scoreCorporateAction,
  scoreEventMateriality,
  scoreMacroDelta,
  scoreMarketMove,
} from "../lib/materiality";

const ev = (
  predicates: string[],
  extra: Partial<Parameters<typeof scoreEventMateriality>[0]> = {},
) =>
  scoreEventMateriality({
    predicates,
    entityTypes: [],
    entitySlugs: [],
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
    entityTypes: ["company"],
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

test("discrete policy-rate step → major decision", () => {
  const a = macro({
    seriesCode: "FEDFUNDS",
    value: 4.0,
    prevValue: 3.75,
    history: hist(3.5),
  });
  assert.equal(a.materiality, "major");
  assert.equal(a.directness, "direct");
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
    currency: "VND",
    referencePrice: 100,
    splitFactor: null,
    ...extra,
  });

test("tiny dividend → limited; big yield → meaningful", () => {
  assert.equal(ca(0.1).materiality, "limited");
  assert.equal(ca(6).materiality, "meaningful");
});

test("no price context → limited + caution", () => {
  const a = ca(5, { referencePrice: null });
  assert.equal(a.materiality, "limited");
  assert.ok(a.cautions.includes("no_price_context"));
});

test("split is mechanical — no channel, limited", () => {
  const a = scoreCorporateAction({
    actionType: "stock_split",
    instrumentKey: "equity:NGS:AAPL",
    cashAmount: null,
    currency: null,
    referencePrice: 341,
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
  const a = mv(3, 1, { isIndex: true, assetClass: "index" });
  assert.equal(a.materiality, "meaningful");
  assert.equal(a.scope, "global_systemic");
});

test("wire-copy count cannot inflate — scorer has no such input", () => {
  const base = {
    predicates: ["sanctions", "interest_rate"],
    entityTypes: [] as string[],
    entitySlugs: [] as string[],
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
});
