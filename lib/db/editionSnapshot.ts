/**
 * Edition snapshot store — the serialized Edition JSON as append-only
 * jsonb rows (one row per build; latest id wins). This is the serverless
 * read path: on Vercel .cache/ is ephemeral, so getEdition serves this
 * instead of the filesystem snapshot. Inert without DATABASE_URL —
 * callers gate on dbEnabled() and treat a missing row as cache-miss.
 */
import { getPool, toJsonb } from "./pool";
import type { Edition } from "../model";

/** ~1 day of 30-min builds — enough history to compare editions,
 *  bounded so the free-tier DB doesn't grow ~24MB/day forever. */
const SNAPSHOT_RETENTION = 48;

export async function saveEditionSnapshot(payload: unknown): Promise<void> {
  const db = getPool();
  await db.query(`INSERT INTO edition_snapshots (payload) VALUES ($1::jsonb)`, [
    toJsonb(payload),
  ]);
  await db
    .query(
      `DELETE FROM edition_snapshots
       WHERE id NOT IN (
         SELECT id FROM edition_snapshots
         ORDER BY id DESC LIMIT ${SNAPSHOT_RETENTION}
       )`,
    )
    .catch((e) =>
      console.warn("[edition_snapshots] prune skipped:", e.message),
    );
}

export async function getLatestEditionSnapshot(): Promise<Edition | null> {
  const { rows } = await getPool().query<{ payload: Edition }>(
    `SELECT payload FROM edition_snapshots ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.payload ?? null;
}
