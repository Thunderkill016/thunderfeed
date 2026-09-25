import { Pool } from "pg";

/**
 * Single shared pool. DATABASE_URL points at Postgres (Supabase included).
 * Without it the writer layer is inert — callers must treat persistence as
 * optional, matching the app's cache-fallback philosophy.
 */
let pool: Pool | null = null;

export function dbEnabled(): boolean {
  return Boolean(pool ?? process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — db layer disabled");
  }
  const url = process.env.DATABASE_URL;
  // SSL only for remote hosts — loopback Postgres speaks plain TCP.
  const isLocal = /(?:localhost|127\.|::1|\[::1\])/.test(url);
  pool ??= new Pool({
    connectionString: url,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 4,
  });
  return pool;
}

/** Test seam — inject a pg-mem (or other pg-compatible) pool. */
export function injectPool(p: Pool | null): void {
  pool = p;
}

/**
 * Serialize a value for a jsonb parameter. Postgres rejects \u0000 inside
 * jsonb input even when escaped, and rejects the raw byte in text columns
 * too — one scraped article containing a NUL would otherwise sink a whole
 * persist transaction with "invalid input syntax for type json". Sets are
 * emitted as arrays (resolver features rely on it).
 */
export function toJsonb(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x))
    .replace(/\\u0000/g, " ")
    .replace(/\u0000/g, " ");
}

/**
 * Canonicalize a claim value for EQUALITY only (position identity, dedup)
 * — never for storage. A numeric string is the same fact as the number
 * ("4" === 4) and a reordered range is the same fact ({low,high} ===
 * {high,low}); JSON.stringify would split them into false positions.
 */
export function canonValue(v: unknown): unknown {
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))
    return Number(v);
  if (Array.isArray(v)) return v.map(canonValue);
  if (v && typeof v === "object" && !(v instanceof Set)) {
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, canonValue(rec[k])]),
    );
  }
  return v;
}
