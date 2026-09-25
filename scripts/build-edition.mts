/**
 * Standalone edition builder — the heavy pipeline OUTSIDE the web request.
 * Run on a schedule (cron/systemd) from the repo root:
 *
 *   npm run build:edition
 *
 * With DATABASE_URL in .env.local pointing at the REMOTE Postgres
 * (e.g. Supabase) the run persists canonical event history AND the
 * edition_snapshots row the Vercel deployment serves — serverless
 * getEdition() never rebuilds, it only reads that row.
 *
 * Env (in .env.local): DATABASE_URL, GEMINI_API_KEY (optional).
 */

import { readFileSync } from "node:fs";
import { refreshEdition } from "../lib/edition";
import { dbEnabled } from "../lib/db/pool";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

async function main() {
  if (!dbEnabled())
    console.warn(
      "DATABASE_URL unset — snapshot lands in .cache/ only, Vercel won't see it",
    );
  const started = Date.now();
  const edition = await refreshEdition();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const pillarEvents = edition.pillars.reduce((n, p) => n + p.events.length, 0);
  console.log(
    `edition built in ${secs}s — ${edition.totalArticles} articles, ` +
      `${pillarEvents} pillar events, ${edition.wire.length} wire items, ` +
      `${edition.trending.length} trending terms, ` +
      `${edition.sources.filter((s) => s.status === "ok").length}/${edition.sources.length} sources ok`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("build:edition failed:", e);
  process.exit(1);
});
