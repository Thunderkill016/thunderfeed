import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Article, StoryCluster } from "../lib/model";

const dir = mkdtempSync(join(tmpdir(), "tf-track-"));
process.env.TRACKING_STATE_PATH = join(dir, "clusters.json");
const { applyTracking } = await import("../lib/tracking");

test.after(() => rmSync(dir, { recursive: true, force: true }));

function cluster(over: Partial<StoryCluster> = {}): StoryCluster {
  const articles: Article[] = over.articles ?? [
    {
      id: "a1",
      title: "Sự kiện thử nghiệm",
      summary: "",
      url: "https://a.vn/1",
      image: null,
      publishedAt: new Date().toISOString(),
      source: "VnExpress",
      topic: "vietnam",
      headline: false,
      appearances: [],
      language: "vi",
    },
  ];
  return {
    id: over.id ?? "cluster-x",
    title: over.title ?? "Sự kiện thử nghiệm",
    summary: "",
    leadArticle: articles[0],
    articles,
    sources: over.sources ?? [{ name: "VnExpress", url: "https://a.vn/1" }],
    topic: "vietnam",
    scope: "vietnam",
    significanceScore: 10,
    publishedAt: new Date().toISOString(),
    ...over,
  };
}

const T0 = "2026-09-24T00:00:00Z";
const T1 = "2026-09-24T00:15:00Z";

test("first sighting marks emerging, same story next edition turns steady/accelerating", () => {
  const c = cluster();
  const changes = applyTracking([c], T0);
  assert.equal(c.momentum?.phase, "emerging");
  assert.equal(changes.newEvents, 1);

  // same cluster (same article ids) next edition, no growth → steady
  const c2 = cluster();
  applyTracking([c2], T1);
  assert.equal(c2.momentum?.phase, "steady");
  assert.equal(c2.momentum?.firstSeen, T0);

  // new articles + new source joined → accelerating
  const grown = cluster({
    articles: [
      c2.articles[0],
      {
        ...c2.articles[0],
        id: "a2",
        source: "Tuổi Trẻ",
        url: "https://b.vn/2",
      },
      {
        ...c2.articles[0],
        id: "a3",
        source: "Tuổi Trẻ",
        url: "https://b.vn/3",
      },
    ],
    sources: [
      { name: "VnExpress", url: "https://a.vn/1" },
      { name: "Tuổi Trẻ", url: "https://b.vn/2" },
    ],
  });
  applyTracking([grown], "2026-09-24T00:30:00Z");
  assert.equal(grown.momentum?.phase, "accelerating");
  assert.equal(grown.momentum?.newArticles, 2);
  assert.deepEqual(grown.momentum?.newSources, ["Tuổi Trẻ"]);
});

test("aged cluster with no new material turns cooling", () => {
  const c = cluster({ id: "cluster-y" });
  applyTracking([c], T0);
  const later = cluster({ id: "cluster-y" });
  applyTracking([later], "2026-09-24T08:00:00Z");
  assert.equal(later.momentum?.phase, "cooling");
});
