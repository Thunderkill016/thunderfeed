/** Shared helpers for the benchmark harness. */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { newDb, DataType } from "pg-mem";
import type { Pool } from "pg";
import { injectPool } from "../../lib/db/pool";
import type { Article, StoryCluster } from "../../lib/model";

/* ------------------------------- labeled data ------------------------------ */

export interface BenchDoc {
  source: string;
  title: string;
  summary?: string;
  url?: string;
  language?: "vi" | "en";
  topic?: Article["topic"];
  publishedAt?: string;
}

export interface EventPair {
  id: string;
  a: BenchDoc;
  b: BenchDoc;
  /** "same" | "diff" — null while unlabeled */
  label: "same" | "diff" | null;
  /** mining tags: cross-lang, generic-claim, same-topic… */
  trap?: string[];
}

export interface ClaimGold {
  id: string;
  article: BenchDoc;
  /** the claims a human says this article asserts */
  claims: { predicate: string; value: unknown; subject?: string }[];
}

export interface OrderCase {
  id: string;
  /** shared claim identity — all assertions are votes on this claim */
  claim: { claimKey: string; predicate: string; label: string };
  /** one cluster per assertion, replayed in sequence */
  assertions: {
    source: string;
    value: unknown;
    title: string;
    primary?: boolean;
    /** evidence-time — votes order by this, not ingestion order */
    publishedAt?: string;
  }[];
}

export const BENCH_DIR = fileURLToPath(new URL("../../bench", import.meta.url));

export function readJsonl<T>(file: string): T[] {
  try {
    return readFileSync(`${BENCH_DIR}/${file}`, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/* --------------------------------- db setup -------------------------------- */

export function setupBenchDb(): Pool {
  const db = newDb();
  const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));
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
    .replace(/-- == PG-ONLY:[\s\S]*?(?=COMMIT;)/, "");
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

/* ------------------------------ cluster builders ---------------------------- */

export function docToArticle(d: BenchDoc, i = 0): Article {
  return {
    id: `bench-${i}-${randomUUID().slice(0, 8)}`,
    title: d.title,
    summary: d.summary ?? "",
    url: d.url ?? `https://bench.local/${randomUUID()}`,
    image: null,
    publishedAt: d.publishedAt ?? new Date().toISOString(),
    source: d.source,
    topic: d.topic ?? "world",
    headline: false,
    appearances: [],
    language: d.language ?? "vi",
  };
}

export function docToCluster(d: BenchDoc): StoryCluster {
  const a = docToArticle(d);
  return {
    id: `bc-${randomUUID().slice(0, 8)}`,
    title: d.title,
    summary: d.summary ?? "",
    leadArticle: a,
    articles: [a],
    sources: [{ name: d.source, url: a.url }],
    topic: d.topic ?? "world",
    scope: "world",
    significanceScore: 100,
    publishedAt: a.publishedAt,
  };
}

const VI_CHARS =
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

export function detectLang(text: string): "vi" | "en" {
  return VI_CHARS.test(text) ? "vi" : "en";
}
