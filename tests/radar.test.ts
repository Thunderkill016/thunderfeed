/* Radar — unified change feed. Pure ranking semantics: magnitude ×
 * abnormality × relevance × freshness × evidence, with a relevance
 * multiplier and a display floor. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abnormalityFactor,
  buildRadarFeed,
  freshnessFactor,
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
    ...partial,
  };
}

test("freshnessFactor: decays to ~0.5 around 24h, never negative", () => {
  assert.ok(freshnessFactor(0) === 1);
  assert.ok(freshnessFactor(24) > 0.4 && freshnessFactor(24) < 0.6);
  assert.ok(freshnessFactor(72) < 0.2);
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
  const watch = { entities: ["bitcoin"], topics: [] as never[] };
  const ent = itemRelevance(["bitcoin"], null, watch);
  assert.deepEqual(ent.matched, ["bitcoin"]);
  assert.ok(ent.score >= 0.6);
  const topicOnly = itemRelevance([], "business", {
    entities: [],
    topics: ["business"],
  });
  assert.equal(topicOnly.score, 0.15);
  assert.equal(itemRelevance([], null, watch).score, 0);
});

test("radarScore: relevance is a multiplier with a floor", () => {
  const base = {
    magnitude: 0.8,
    abnormality: 0.9,
    freshness: 0.9,
    evidence: 0.8,
  };
  const watched = radarScore({ ...base, relevance: 1 });
  const unwatched = radarScore({ ...base, relevance: 0 });
  assert.ok(watched > unwatched);
  assert.ok(unwatched > 0); // floor — never vanishes silently
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
  const watch = { entities: ["bitcoin"], topics: [] as never[] };
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
    { entities: [], topics: [] },
    NOW,
  );
  assert.equal(feed[0].id, "e-fresh");
});

test("watchFromCookie: parses mirror cookie, tolerates garbage", () => {
  const w = watchFromCookie(
    encodeURIComponent(
      JSON.stringify({ entities: ["fed"], topics: ["business"] }),
    ),
  );
  assert.deepEqual(w.entities, ["fed"]);
  assert.deepEqual(w.topics, ["business"]);
  assert.deepEqual(watchFromCookie("not-json%25"), {
    entities: [],
    topics: [],
  });
  assert.deepEqual(watchFromCookie(undefined), { entities: [], topics: [] });
  // unknown topics dropped by the vocab filter
  assert.deepEqual(
    watchFromCookie(encodeURIComponent('{"entities":[],"topics":["bogus"]}'))
      .topics,
    [],
  );
});
