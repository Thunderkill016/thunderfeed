/**
 * Embedding stage bounds — the semantic layer is optional, so it must never
 * hang an edition build. Regression: a 429 carrying a daily-quota
 * "retry in Ns" (N = hours) used to sleep unboundedly inside embedOne and
 * wedge the whole pipeline at zero CPU. The quota breaker must also make
 * later calls fail fast — persistCluster pre-warms once per cluster, so
 * without it each cluster would burn the full stage budget.
 *
 * Test order matters: the quota breaker is module-level state, so the
 * success test runs before the quota trip.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.THUNDERFEED_EMBED_CACHE = "/tmp/tf-test-embed-cache-none.json";

test("embedArticles: successful embed returns vectors for uncached ids", async () => {
  const realFetch = globalThis.fetch;
  const v = Array.from({ length: 768 }, (_, i) => i / 768);
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ embedding: { values: v } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as never;
  try {
    const { embedArticles } = await import("../lib/embed");
    const vectors = await embedArticles("k", [{ id: "x", text: "hello" }]);
    assert.equal(vectors.get("x")?.length, 768);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("embedArticles: daily-quota 429 (retry in hours) returns fast, no hang", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "Quota exceeded, retry in 3600s" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    )) as never;
  try {
    const { embedArticles } = await import("../lib/embed");
    const t0 = Date.now();
    const vectors = await embedArticles("k", [
      { id: "a", text: "Fed giữ lãi suất" },
      { id: "b", text: "Trung Quốc xuất khẩu" },
    ]);
    assert.ok(Date.now() - t0 < 30_000, "must not sleep for the server hint");
    assert.equal(vectors.size, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("embedArticles: quota breaker makes subsequent calls return instantly", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "Quota exceeded, retry in 3600s" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as never;
  try {
    const { embedArticles } = await import("../lib/embed");
    const t0 = Date.now();
    const vectors = await embedArticles("k", [
      { id: "c", text: "one" },
      { id: "d", text: "two" },
    ]);
    assert.ok(Date.now() - t0 < 5_000, "breaker must short-circuit");
    assert.equal(vectors.size, 0);
    assert.equal(calls, 0, "breaker must skip the API entirely");
  } finally {
    globalThis.fetch = realFetch;
  }
});
