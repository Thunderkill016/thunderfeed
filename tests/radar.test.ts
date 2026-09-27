/* Radar — unified change feed. Pure ranking semantics: magnitude ×
 * abnormality × relevance × freshness × evidence, with a relevance
 * multiplier and a display floor. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abnormalityFactor,
  buildRadarFeed,
  freshnessFactor,
  instrumentMatches,
  itemRelevance,
  radarScore,
} from "../lib/radar";
import { watchFromCookie } from "../lib/relevance";
import type { DataDeltaView, EventListItem } from "../lib/db/read";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function delta(partial: Partial<DataDeltaView>): DataDeltaView {
  return {
    id: "d1",
    kind: "market_move",
    materiality: "medium",
    summary: "BTCUSDT +4.1% phiên 2026-09-27",
    detectedAt: "2026-09-27T08:00:00Z",
    seriesKey: null,
    seriesCode: null,
    entityKey: null,
    actionType: null,
    instrumentKey: "instrument:bitcoin:crypto",
    ticker: "BTCUSDT",
    ...partial,
  };
}

function event(partial: Partial<EventListItem>): EventListItem {
  return {
    id: "e1",
    title: "Bitcoin lao dốc sau tin ETF",
    status: "emerging",
    topic: "business",
    firstSeenAt: "2026-09-26T00:00:00Z",
    lastSeenAt: "2026-09-27T09:00:00Z",
    claimCount: 3,
    sourceCount: 5,
    independentOrigins: 4,
    primaryOrigins: 1,
    unresolvedOrigins: 0,
    derivedDocuments: 1,
    supportedCount: 2,
    disputedCount: 0,
    entities: [],
    ...partial,
  };
}

test("freshnessFactor: true 36h half-life, never negative", () => {
  assert.ok(freshnessFactor(0) === 1);
  assert.equal(freshnessFactor(36), 0.5);
  assert.ok(freshnessFactor(72) === 0.25);
  assert.ok(freshnessFactor(-5) === 1);
});

test("abnormalityFactor: event status and materiality buckets", () => {
  assert.equal(abnormalityFactor("high"), 1);
  assert.equal(abnormalityFactor("medium"), 0.6);
  assert.ok(
    abnormalityFactor("", "emerging") > abnormalityFactor("", "resolved"),
  );
});

test("itemRelevance: entity match dominates topic match", () => {
  const watch = {
    entities: ["bitcoin"],
    instruments: [],
    topics: [] as never[],
  };
  const ent = itemRelevance(["bitcoin"], null, [], watch);
  assert.deepEqual(ent.matched, ["bitcoin"]);
  assert.ok(ent.score >= 0.6);
  const topicOnly = itemRelevance([], "business", [], {
    entities: [],
    instruments: [],
    topics: ["business"],
  });
  assert.equal(topicOnly.score, 0.15);
  assert.equal(itemRelevance([], null, [], watch).score, 0);
});

test("radarScore: relevance is additive, bounded — never buries impact", () => {
  const base = {
    magnitude: 0.8,
    abnormality: 0.9,
    freshness: 0.9,
    evidence: 0.8,
  };
  const watched = radarScore({ ...base, relevance: 1 });
  const unwatched = radarScore({ ...base, relevance: 0 });
  assert.ok(watched > unwatched);
  // additive term can add at most ~20pts, not rescale the whole score —
  // a watched local story must not bury a global summit (bench finding)
  assert.ok(watched - unwatched <= 20.5);
  assert.ok(unwatched > 0);
});

test("radarScore: weights sum to 1 so max score is 100", () => {
  const max = radarScore({
    magnitude: 1,
    abnormality: 1,
    relevance: 1,
    freshness: 1,
    evidence: 1,
  });
  assert.equal(max, 100);
});

test("buildRadarFeed: watched entity boosts its item to the top", () => {
  const stale = event({
    id: "e-old",
    title: "Tin vắn thế giới",
    status: "stable",
    lastSeenAt: "2026-09-24T00:00:00Z",
    claimCount: 0,
    sourceCount: 1,
  });
  const hot = delta({ id: "d-hot", ticker: "BTCUSDT" });
  const watch = {
    entities: ["bitcoin"],
    instruments: [],
    topics: [] as never[],
  };
  const feed = buildRadarFeed(
    [delta({ id: "d1", detectedAt: "2026-09-20T00:00:00Z" }), hot],
    [stale, event({ id: "e1" })],
    watch,
    NOW,
  );
  assert.equal(feed[0].id, "d-hot");
  const btc = feed.find((f) => f.id === "d-hot")!;
  assert.ok(btc.matched.includes("bitcoin"));
  // related news attached via ticker keywords
  assert.ok(btc.related.some((r) => r.id === "e1"));
});

test("buildRadarFeed: no watch → neutral relevance, recency leads", () => {
  const fresh = event({
    id: "e-fresh",
    lastSeenAt: new Date(NOW).toISOString(),
  });
  const stale = event({
    id: "e-stale",
    lastSeenAt: "2026-09-20T00:00:00Z",
  });
  const feed = buildRadarFeed(
    [],
    [stale, fresh],
    { entities: [], instruments: [], topics: [] },
    NOW,
  );
  assert.equal(feed[0].id, "e-fresh");
});

test("buildRadarFeed: same-story events collapse to one slot", () => {
  // sub-stories the resolver kept separate but the feed must not stack:
  // summit arrival + truce + red-line all share trump/us/xijinping
  const a = event({
    id: "e-a",
    title: "Ông Trump đón ông Tập tại sân bay Mỹ",
    sourceCount: 58,
    claimCount: 200,
  });
  const b = event({
    id: "e-b",
    title: "Ông Tập tới Mỹ: ông Trump đón, đình chiến thương mại",
    sourceCount: 40,
    claimCount: 30,
  });
  const other = event({
    id: "e-c",
    title: "Giá vàng giảm mạnh sau phiên giao dịch",
    sourceCount: 40,
    claimCount: 30,
  });
  const feed = buildRadarFeed(
    [],
    [a, b, other],
    { entities: [], instruments: [], topics: [] },
    NOW,
  );
  const ids = feed.map((f) => f.id);
  // exactly one summit sub-story survives — the stronger one
  const summit = ids.filter((i) => i === "e-a" || i === "e-b");
  assert.equal(summit.length, 1);
  assert.equal(summit[0], "e-a");
});

test("buildRadarFeed: boilerplate formats sink below real events", () => {
  const weather = event({
    id: "e-wx",
    title: "Dự báo thời tiết 27/9: Miền Bắc nắng 34 độ",
    sourceCount: 14,
  });
  const policy = event({
    id: "e-pol",
    title: "Tô Lâm phát biểu tại Quốc hội về tăng trưởng",
    sourceCount: 14,
  });
  const feed = buildRadarFeed(
    [],
    [weather, policy],
    { entities: [], instruments: [], topics: [] },
    NOW,
  );
  assert.equal(feed[0].id, "e-pol");
});

test("instrumentMatches: bare 'usd' in a headline can't hit a ty_gia watch", () => {
  const watch = {
    entities: [],
    instruments: ["ty_gia"],
    topics: [] as never[],
  };
  // "20 tỷ USD" is an amount, not an FX story — keyword stoplist
  assert.equal(
    instrumentMatches(
      "Thương mại Việt Nam-Malaysia hướng tới mốc 20 tỷ USD",
      null,
      watch,
    ).length,
    0,
  );
  // but an actual FX headline still hits
  assert.ok(
    instrumentMatches("Tỷ giá USD/VND tăng mạnh", null, watch).includes(
      "ty_gia",
    ),
  );
});

test("buildRadarFeed: systemic premium delta floors above a plain medium move", () => {
  const prem = delta({
    id: "d-prem",
    kind: "premium_shift",
    summary: "premium SJC +0.92pt → 8.59% phiên 2026-09-27",
    instrumentKey: "instrument:sjc_world_premium:index",
    ticker: "SJC-PREM",
  });
  const move = delta({
    id: "d-move",
    kind: "market_move",
    summary: "SOLUSDT +2.1% phiên 2026-09-27",
    instrumentKey: "instrument:solana:crypto",
    ticker: "SOLUSDT",
  });
  const feed = buildRadarFeed(
    [move, prem],
    [],
    { entities: [], instruments: [], topics: [] },
    NOW,
  );
  assert.equal(feed[0].id, "d-prem");
});

test("watchFromCookie: parses mirror cookie, tolerates garbage", () => {
  const w = watchFromCookie(
    encodeURIComponent(
      JSON.stringify({
        entities: ["fed"],
        instruments: [],
        topics: ["business"],
      }),
    ),
  );
  assert.deepEqual(w.entities, ["fed"]);
  assert.deepEqual(w.topics, ["business"]);
  const empty = { entities: [], instruments: [], topics: [] };
  assert.deepEqual(watchFromCookie("not-json%25"), empty);
  assert.deepEqual(watchFromCookie(undefined), empty);
  // pre-R2 cookies had no instruments — degrade to []
  assert.deepEqual(
    watchFromCookie(encodeURIComponent('{"entities":["fed"]}')).instruments,
    [],
  );
  // unknown topics dropped by the vocab filter
  assert.deepEqual(
    watchFromCookie(encodeURIComponent('{"entities":[],"topics":["bogus"]}'))
      .topics,
    [],
  );
});
