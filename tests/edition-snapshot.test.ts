/**
 * Edition snapshot store (pg-mem, real 0008 migration) + getEdition's
 * fs↔DB read ordering: fs-first locally, DB-first on Vercel, fs fallback.
 * THUNDERFEED_EDITION_CACHE and VERCEL are read at module load / call
 * time, so each scenario sets env BEFORE a cache-busted dynamic import —
 * memEdition is module state and must not leak between scenarios.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { injectPool } from "../lib/db/pool";
import {
  getLatestEditionSnapshot,
  saveEditionSnapshot,
} from "../lib/db/editionSnapshot";
import type { Edition } from "../lib/model";

function setupDb() {
  const db = newDb();
  const sql = readFileSync(
    fileURLToPath(
      new URL("../db/migrations/0008_edition_snapshots.sql", import.meta.url),
    ),
    "utf8",
  );
  db.public.none(sql);
  const pg = db.adapters.createPg();
  injectPool(new pg.Pool() as unknown as Pool);
}

const fakeEdition = (marker: string, ageMin = 0) =>
  ({
    updatedAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
    marker,
  }) as unknown as Edition;

function fsSnapshot(marker: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tf-edition-"));
  const p = path.join(dir, "edition.json");
  writeFileSync(p, JSON.stringify(fakeEdition(marker)));
  return p;
}

async function freshGetEdition(tag: string, snapshotPath: string) {
  process.env.THUNDERFEED_EDITION_CACHE = snapshotPath;
  const m = await import(`../lib/edition.ts?${tag}`);
  return m.getEdition() as Promise<Edition & { marker?: string }>;
}

test("edition_snapshots roundtrip — latest row wins", async () => {
  setupDb();
  await saveEditionSnapshot(fakeEdition("old"));
  await saveEditionSnapshot(fakeEdition("new"));
  const snap = await getLatestEditionSnapshot();
  assert.equal((snap as { marker?: string }).marker, "new");
});

test("getEdition on Vercel prefers the DB snapshot over fs", async () => {
  setupDb();
  await saveEditionSnapshot(fakeEdition("db"));
  process.env.VERCEL = "1";
  try {
    const snap = await freshGetEdition("vercel", fsSnapshot("fs"));
    assert.equal(snap?.marker, "db");
  } finally {
    delete process.env.VERCEL;
  }
});

test("getEdition locally prefers the fs snapshot over DB", async () => {
  setupDb();
  await saveEditionSnapshot(fakeEdition("db"));
  const snap = await freshGetEdition("local", fsSnapshot("fs"));
  assert.equal(snap?.marker, "fs");
});

test("getEdition locally falls back to DB when no fs snapshot exists", async () => {
  setupDb();
  await saveEditionSnapshot(fakeEdition("db"));
  const missing = path.join(
    mkdtempSync(path.join(tmpdir(), "tf-edition-")),
    "edition.json",
  );
  const snap = await freshGetEdition("local-fallback", missing);
  assert.equal(snap?.marker, "db");
});
