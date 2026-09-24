/**
 * Semantic layer — multilingual embeddings via the Gemini embedding API.
 *
 * Lexical clustering (Jaccard over normalized bigrams) cannot join a
 * Vietnamese headline with its English paraphrase: they share almost no
 * vocabulary. Embeddings close that gap. The layer is strictly optional:
 * without GEMINI_API_KEY, on HTTP failure, or on a dimension mismatch, the
 * caller gets null vectors and clustering falls back to lexical-only —
 * never a partial failure.
 *
 * Vectors are persisted to .cache/embeddings.json keyed by article id so
 * recurring articles across 15-minute editions are not re-embedded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export function embedModel(): string {
  return process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
}

/** request shape: gemini-embedding-* supports embedContent only (no batch) */
const EMBED_CONCURRENCY = 6; // free tier ≈100 req/min — bursts trigger 429s
const REQUEST_TIMEOUT = 12_000;
// A 429 "retry in Xs" can mean daily-quota exhaustion, where X is hours.
// Sleeping that long would hang the edition forever — the semantic layer is
// optional, so waits beyond this bound mean "no vector", not "retry later".
const MAX_RETRY_WAIT_MS = 20_000;
// Overall budget for one embedArticles call: the stage must never hold an
// edition build hostage, so workers stop dequeuing once it elapses.
const EMBED_BUDGET_MS = 45_000;
// Daily-quota trips the breaker for at most this long; after it expires one
// cheap probe call decides whether to re-block or resume embedding.
const QUOTA_BLOCK_MAX_MS = 15 * 60_000;
const OUTPUT_DIMS = 768;
const CACHE_TTL_MS = 48 * 3_600_000;
const CACHE_MAX_ENTRIES = 12_000;

type CacheEntry = { v: number[]; t: number };
type CacheFile = { entries: Record<string, CacheEntry> };

function cachePath(): string {
  return process.env.THUNDERFEED_EMBED_CACHE ?? ".cache/embeddings.json";
}

function loadCache(): Map<string, CacheEntry> {
  try {
    if (!existsSync(cachePath())) return new Map();
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
    const cutoff = Date.now() - CACHE_TTL_MS;
    const entries = Object.entries(raw.entries ?? {}).filter(
      ([, e]) => e.t > cutoff && Array.isArray(e.v) && e.v.length > 0,
    );
    return new Map(entries.slice(-CACHE_MAX_ENTRIES));
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CacheEntry>): void {
  try {
    const dir = path.dirname(cachePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = Object.fromEntries([...cache].slice(-CACHE_MAX_ENTRIES));
    writeFileSync(cachePath(), JSON.stringify({ entries }));
  } catch {
    // cache is a best-effort optimization — never fail the edition over it
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Process-level breaker: a quota-exhaustion 429 (daily limit, "retry in
// hours") means every later call will also fail — without it, each
// persistCluster pre-warm would burn the whole stage budget on sleeps.
let quotaBlockedUntil = 0;

async function embedOnce(
  apiKey: string,
  text: string,
): Promise<{ v: number[] | null; retryAfterMs?: number }> {
  const model = embedModel();
  try {
    const res = await fetch(
      `${GEMINI_ENDPOINT}/${model}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: OUTPUT_DIMS,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      },
    );
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      const m = body?.error?.message?.match(/retry in ([\d.]+)s/i);
      const wait = m ? Number(m[1]) * 1000 : 5000;
      if (wait > MAX_RETRY_WAIT_MS)
        quotaBlockedUntil = Date.now() + Math.min(wait, QUOTA_BLOCK_MAX_MS);
      return { v: null, retryAfterMs: wait };
    }
    if (!res.ok) return { v: null };
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const v = data.embedding?.values;
    return { v: v && v.length === OUTPUT_DIMS ? v : null };
  } catch {
    return { v: null };
  }
}

async function embedOne(
  apiKey: string,
  text: string,
): Promise<number[] | null> {
  const first = await embedOnce(apiKey, text);
  if (first.v) return first.v;
  if (first.retryAfterMs !== undefined && first.retryAfterMs <= MAX_RETRY_WAIT_MS) {
    await sleep(first.retryAfterMs + 500);
    const second = await embedOnce(apiKey, text);
    return second.v;
  }
  return null;
}

/**
 * Embed (id, text) pairs with a worker pool, reusing persisted vectors where
 * possible. Returns a lookup of id → vector; absent ids mean "no vector",
 * which the caller must treat as lexical-only for that pair.
 */
export async function embedArticles(
  apiKey: string,
  items: { id: string; text: string }[],
): Promise<Map<string, number[]>> {
  const cache = loadCache();
  const vectors = new Map<string, number[]>();
  const queue: { id: string; text: string }[] = [];
  for (const item of items) {
    const hit = cache.get(item.id);
    if (hit) vectors.set(item.id, hit.v);
    else queue.push(item);
  }

  if (Date.now() < quotaBlockedUntil) return vectors;

  let cursor = 0;
  const deadline = Date.now() + EMBED_BUDGET_MS;
  const worker = async () => {
    while (cursor < queue.length && Date.now() < deadline) {
      if (Date.now() < quotaBlockedUntil) return;
      const item = queue[cursor++];
      const v = await embedOne(apiKey, item.text);
      if (v) {
        vectors.set(item.id, v);
        cache.set(item.id, { v, t: Date.now() });
      }
    }
  };
  await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));

  if (queue.length) saveCache(cache);
  return vectors;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
