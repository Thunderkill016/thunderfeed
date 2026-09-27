/**
 * One-shot database copy — local Postgres → remote (Supabase) — via the
 * COPY wire protocol. Needed because this repo's portable .pg install
 * ships no pg_dump/psql binaries.
 *
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... npx tsx scripts/db-copy.mts
 *
 * (defaults: source = DATABASE_URL from .env.local; target is required —
 * refuses to run into DATABASE_URL so an unset target can't wipe local.)
 *
 * Copies every base table in FK-safe order, skipping edition_snapshots
 * (GENERATED ALWAYS identity; the builder writes fresh rows anyway),
 * then resets target sequences so new rows don't collide with copied ids.
 * Target tables must exist and be EMPTY — run migrations first.
 */

import { readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import * as copy from "pg-copy-streams";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const SOURCE = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
const TARGET = process.env.TARGET_DATABASE_URL;
if (!SOURCE || !TARGET) {
  console.error(
    "need SOURCE_DATABASE_URL|DATABASE_URL and TARGET_DATABASE_URL",
  );
  process.exit(1);
}

const SKIP = new Set(["edition_snapshots"]);

/** parents-before-children over the FK graph; cycles (self-fk) go last. */
async function orderedTables(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{
    table_name: string;
    parent: string | null;
  }>(
    `SELECT t.table_name,
            kcu2.table_name AS parent
     FROM information_schema.tables t
     LEFT JOIN information_schema.table_constraints tc
       ON tc.table_name = t.table_name
      AND tc.table_schema = t.table_schema
      AND tc.constraint_type = 'FOREIGN KEY'
     LEFT JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
     LEFT JOIN information_schema.constraint_column_usage kcu2
       ON kcu2.constraint_name = tc.constraint_name
      AND kcu2.table_schema = tc.table_schema
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
  );
  const deps = new Map<string, Set<string>>();
  for (const r of rows) {
    if (SKIP.has(r.table_name)) continue;
    if (!deps.has(r.table_name)) deps.set(r.table_name, new Set());
    if (r.parent && r.parent !== r.table_name && !SKIP.has(r.parent))
      deps.get(r.table_name)!.add(r.parent);
  }
  const order: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const ready = [...deps.keys()].filter(
      (t) => !done.has(t) && [...deps.get(t)!].every((p) => done.has(p)),
    );
    if (!ready.length) {
      // break a cycle by emitting the rest unordered (self-fks excluded above)
      for (const t of deps.keys()) if (!done.has(t)) order.push(t);
      break;
    }
    for (const t of ready) {
      done.add(t);
      order.push(t);
    }
  }
  return order;
}

async function main() {
  const src = new pg.Client({ connectionString: SOURCE });
  const dst = new pg.Client({ connectionString: TARGET });
  await src.connect();
  await dst.connect();
  try {
    // disable FK triggers on the target for this session — the schema has
    // a documents↔versions cycle (current_version_id), so no table order
    // can satisfy it; this is what pg_dump's restore effectively does.
    await dst.query(`SET session_replication_role = 'replica'`);
    const tables = await orderedTables(src);
    console.log(`copying ${tables.length} tables: ${tables.join(", ")}`);
    for (const t of tables) {
      const { rows } = await src.query<{ c: string }>(
        `SELECT count(*) AS c FROM "${t}"`,
      );
      const n = Number(rows[0].c);
      if (n === 0) {
        console.log(`  ${t}: 0 rows (skip)`);
        continue;
      }
      const started = Date.now();
      await pipeline(
        src.query(copy.to(`COPY "${t}" TO STDOUT`)),
        dst.query(copy.from(`COPY "${t}" FROM STDIN`)),
      );
      console.log(
        `  ${t}: ${n} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
    await dst.query(`SET session_replication_role = 'origin'`);

    // sequences: COPY writes explicit ids, so serial sequences still sit at
    // their start values — realign them or the next insert collides.
    const seqs = await dst.query<{ table_name: string; seq: string }>(
      `SELECT table_name, pg_get_serial_sequence('public.'||table_name, 'id') AS seq
       FROM information_schema.columns
       WHERE table_schema='public' AND column_name='id'`,
    );
    for (const s of seqs.rows) {
      if (!s.seq) continue;
      await dst.query(
        `SELECT setval($1, COALESCE((SELECT max(id) FROM "${s.table_name}"), 1))`,
        [s.seq],
      );
    }
    console.log("sequences realigned — done");
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("db-copy failed:", e);
  process.exit(1);
});
