import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  parseWatch,
  scoreRelevance,
  clusterEntities,
  entitiesInEdition,
  rankEdition,
} from "../lib/relevance";
import type { Article, Edition, StoryCluster } from "../lib/model";

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

function cluster(
  articles: Article[],
  over: Partial<StoryCluster> = {},
): StoryCluster {
  return {
    id: over.id ?? randomUUID(),
    title: articles[0].title,
    summary: articles[0].summary,
    leadArticle: articles[0],
    articles,
    sources: articles.map((a) => ({ name: a.source, url: a.url })),
    topic: over.topic ?? "world",
    scope: over.scope ?? "world",
    significanceScore: 100,
    publishedAt: articles[0].publishedAt,
  };
}

test("parseWatch splits + lowercases entities, keeps topics", () => {
  const w = parseWatch(
    new URLSearchParams("e=Fed, China ,,openai&t=vietnam,world"),
  );
  assert.deepEqual(w.entities, ["federal_reserve", "china", "openai"]);
  assert.deepEqual(w.topics, ["vietnam", "world"]);
});

test("scoreRelevance: entity match dominates topic match", () => {
  const c = cluster([
    art({ title: "Fed giữ nguyên lãi suất sau áp lực từ Trump" }),
  ]);
  const w = { entities: ["federal_reserve"], instruments: [], topics: [] };
  const r = scoreRelevance(c, w);
  assert.equal(r.matchedEntities.length, 1);
  assert.ok(r.score > 0.5, `entity hit should score >0.5, got ${r.score}`);

  const topicOnly = scoreRelevance(c, { entities: [], instruments: [], topics: ["world"] });
  assert.ok(topicOnly.score < r.score, "topic alone scores lower");
  assert.equal(topicOnly.matchedEntities.length, 0);
});

test("scoreRelevance: no match → zero", () => {
  const c = cluster([art({ title: "Thời tiết miền Bắc se lạnh" })]);
  const r = scoreRelevance(c, {
    entities: ["federal_reserve"],
    instruments: [],
    topics: ["technology"],
  });
  assert.equal(r.score, 0);
});

test("clusterEntities uses canonical ontology across vi/en wording", () => {
  const c = cluster([
    art({ title: "Trung Quốc tăng xuất khẩu" }),
    art({ title: "China raises tariffs", source: "Reuters", language: "en" }),
  ]);
  const ents = clusterEntities(c);
  assert.ok(ents.includes("china"), `expected china in ${ents}`);
});

test("entitiesInEdition ranks by frequency, deduped across sections", () => {
  const mk = (t: string) => cluster([art({ title: t })]);
  const edition = {
    hero: mk("Fed cắt giảm lãi suất"),
    pillars: [
      {
        id: "economy",
        label: "x",
        events: [mk("Fed họp tháng 10"), mk("Trung Quốc xuất khẩu")],
      },
    ],
    blindspots: {
      internationalOnly: [mk("Fed cắt giảm lãi suất")],
      domesticOnly: [],
    },
    wire: [],
  } as unknown as Edition;
  const ents = entitiesInEdition(edition);
  assert.equal(ents[0], "federal_reserve", "fed appears 3x → first");
});

test("rankEdition sorts by score and dedupes cluster ids", () => {
  const dup = cluster([art({ title: "Fed cắt giảm lãi suất" })], {
    id: "same-id",
  });
  const weak = cluster([art({ title: "Tin tức thế giới khác" })], {
    topic: "world",
  });
  const edition = {
    hero: dup,
    pillars: [{ id: "economy", label: "x", events: [dup, weak] }],
    blindspots: { internationalOnly: [], domesticOnly: [] },
    wire: [],
  } as unknown as Edition;
  const ranked = rankEdition(edition, {
    entities: ["federal_reserve"],
    instruments: [],
    topics: [],
  });
  assert.equal(ranked.length, 1, "duplicate cluster id appears once");
  assert.equal(ranked[0].cluster.id, "same-id");
});
