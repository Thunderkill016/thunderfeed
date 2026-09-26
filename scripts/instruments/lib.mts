/* Shared helpers for instrument-master import scripts.
 * Raw provider payloads are always persisted to reference_observations
 * (append-only, content-hash deduped) before any derived row is written. */
import { createHash } from "node:crypto";
import pg from "pg";

export function connectDb(url = process.env.DATABASE_URL): pg.Client {
  if (!url) throw new Error("DATABASE_URL required");
  return new pg.Client({ connectionString: url });
}

/** Stable sha256 over a JSON value (key order canonicalized). */
export function contentHash(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(",")}}`;
}

export interface ObservationRef {
  provider: string;
  dataset: string;
  recordKey: string;
  sourceUrl?: string;
  payload: unknown;
  observedAt?: string;
}

/** Insert one raw observation; identical content dedupes (returns existing id). */
export async function observe(
  c: pg.Client,
  ref: ObservationRef,
): Promise<string> {
  const hash = contentHash(ref.payload);
  const ins = await c.query(
    `INSERT INTO reference_observations
       (provider, dataset, record_key, source_url, payload, content_hash, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider, dataset, record_key, content_hash) DO NOTHING
     RETURNING id`,
    [
      ref.provider,
      ref.dataset,
      ref.recordKey,
      ref.sourceUrl ?? null,
      JSON.stringify(ref.payload),
      hash,
      ref.observedAt ?? null,
    ],
  );
  if (ins.rows.length) return ins.rows[0].id as string;
  const sel = await c.query(
    `SELECT id FROM reference_observations
      WHERE provider=$1 AND dataset=$2 AND record_key=$3 AND content_hash=$4`,
    [ref.provider, ref.dataset, ref.recordKey, hash],
  );
  return sel.rows[0].id as string;
}

export async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}
