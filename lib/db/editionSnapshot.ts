/**
 * Edition snapshot store — the serialized Edition JSON as append-only
 * jsonb rows (one row per build; latest id wins). This is the serverless
 * read path: on Vercel .cache/ is ephemeral, so getEdition serves this
 * instead of the filesystem snapshot. Inert without DATABASE_URL —
 * callers gate on dbEnabled() and treat a missing row as cache-miss.
 */
import { getPool, toJsonb } from "./pool";
import type { Edition } from "../model";

export async function saveEditionSnapshot(payload: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO edition_snapshots (payload) VALUES ($1::jsonb)`,
    [toJsonb(payload)],
  );
}

export async function getLatestEditionSnapshot(): Promise<Edition | null> {
  const { rows } = await getPool().query<{ payload: Edition }>(
    `SELECT payload FROM edition_snapshots ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.payload ?? null;
}
