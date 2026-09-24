import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { extractClaims } from "../lib/db/extract";
import type { Article, StoryCluster } from "../lib/model";

function art(over: Partial<Article>): Article {
  return {
    id: over.id ?? randomUUID(),
    title: over.title ?? "title",
    summary: over.summary ?? "",
    url: over.url ?? `https://x.vn/${randomUUID()}`,
    image: null,
    publishedAt: over.publishedAt ?? new Date().toISOString(),
    source: over.source ?? "VnExpress",
    topic: over.topic ?? "world",
    headline: false,
    appearances: [],
    language: over.language ?? "vi",
  };
}

function cluster(articles: Article[]): StoryCluster {
  return {
    id: "c1",
    title: articles[0].title,
    summary: articles[0].summary,
    leadArticle: articles[0],
    articles,
    sources: articles.map((a) => ({ name: a.source, url: a.url })),
    topic: "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: articles[0].publishedAt,
  };
}

test("vi numeric claim: chuyến bay bị hủy", () => {
  const claims = extractClaims(
    cluster([art({ title: "Bão lớn: 20 chuyến bay bị hủy" })]),
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimKey, "flights_cancelled");
  assert.equal(claims[0].value, 20);
  assert.equal(claims[0].unit, "flights");
  assert.equal(claims[0].assertedBy, "VnExpress");
});

test("vi and en map to the same claim_key — one claim, versioned", () => {
  const claims = extractClaims(
    cluster([
      art({ source: "VnExpress", title: "Bão lớn: 20 chuyến bay bị hủy" }),
      art({
        source: "BBC World News",
        title: "Storm grounds travel — 20 flights cancelled",
        language: "en",
      }),
      art({ source: "Tuổi Trẻ", title: "Bão lớn: 35 chuyến bay bị hủy" }),
    ]),
  );
  const flights = claims.filter((c) => c.claimKey === "flights_cancelled");
  assert.equal(flights.length, 3);
  assert.deepEqual(
    flights.map((c) => c.value as number).sort((a, b) => a - b),
    [20, 20, 35],
  );
  // each carries its own asserting source → corroborating evidence rows
  assert.deepEqual(flights.map((c) => c.assertedBy).sort(), [
    "BBC World News",
    "Tuổi Trẻ",
    "VnExpress",
  ]);
});

test("vi deaths claim with reversed word order", () => {
  const claims = extractClaims(
    cluster([art({ title: "Lũ lụt khiến 15 người chết" })]),
  );
  assert.equal(claims[0].claimKey, "deaths");
  assert.equal(claims[0].value, 15);
});

test("vi damage scale: nghìn tỷ đồng multiplies by 1000", () => {
  const claims = extractClaims(
    cluster([art({ title: "Bão gây thiệt hại khoảng 3 nghìn tỷ đồng" })]),
  );
  assert.equal(claims[0].claimKey, "damage_vnd");
  assert.equal(claims[0].value, 3000);
});

test("en damage normalizes million to usd_bn", () => {
  const claims = extractClaims(
    cluster([
      art({
        title: "Storm damage estimated at $500 million",
        language: "en",
      }),
    ]),
  );
  assert.equal(claims[0].claimKey, "damage_usd");
  assert.equal(claims[0].value, 0.5);
});

test("vi interest rate percent", () => {
  const claims = extractClaims(
    cluster([art({ title: "NHNN giữ lãi suất ở mức 4,5%" })]),
  );
  // subject detected → identity is subject|predicate, not bare predicate
  assert.equal(claims[0].claimKey, "nhnn|interest_rate");
  assert.equal(claims[0].value, 4.5);
});

test("dedup: same source + key + value emitted once", () => {
  const claims = extractClaims(
    cluster([
      art({ title: "Bão: 20 chuyến bay bị hủy" }),
      art({ title: "Diễn biến mới: 20 chuyến bay bị hủy" }),
    ]),
  );
  assert.equal(claims.length, 1);
});

test("vi money_usd: triệu USD normalizes to tỷ", () => {
  const claims = extractClaims(
    cluster([art({ title: "Việt Nam góp 1,3 triệu USD cho ngân sách LHQ" })]),
  );
  const c = claims.find((x) => x.claimKey === "money_usd")!;
  assert.equal(c.value, 0.0013);
  assert.equal(c.unit, "ty_usd");
});

test("en money_usd range: $10-20 billion → {low,high}", () => {
  const claims = extractClaims(
    cluster([
      art({ title: "Plan calls for $10-20 billion in bonds", language: "en" }),
    ]),
  );
  assert.deepEqual(claims[0].value, { low: 10, high: 20 });
  assert.equal(claims[0].valueType, "range");
});

test("vi victims via reversed fraud phrasing", () => {
  const claims = extractClaims(
    cluster([art({ title: "Công ty GFDI lừa hơn 7.100 khách hàng" })]),
  );
  assert.equal(claims[0].claimKey, "victims");
  assert.equal(claims[0].value, 7100);
});

test("en prison sentence", () => {
  const claims = extractClaims(
    cluster([
      art({
        title: "Weinstein sentenced to 15 years in prison",
        language: "en",
      }),
    ]),
  );
  assert.equal(claims[0].claimKey, "sentence_years");
  assert.equal(claims[0].value, 15);
});

test("span guard: damage_vnd wins over generic money_vnd", () => {
  const claims = extractClaims(
    cluster([art({ title: "Bão gây thiệt hại khoảng 3 nghìn tỷ đồng" })]),
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimKey, "damage_vnd");
  assert.equal(claims[0].value, 3000);
});

test("unmatched text produces no claims — precision over recall", () => {
  const claims = extractClaims(
    cluster([
      art({ title: "Thủ tướng phát biểu tại hội nghị" }),
      art({ title: "Markets rally on Fed hopes", language: "en" }),
    ]),
  );
  assert.equal(claims.length, 0);
});
