/* ISO 10383 MIC importer — official SWIFT RA dataset, never seeded from memory.
 *
 *   npx tsx scripts/instruments/import-mic.mts [--file /path/mic.csv] [--mics XNAS,XNYS]
 *
 * Downloads the official CSV, stores one reference_observation per imported
 * MIC row (dataset 'mic_list', payload = raw parsed row + file hash), then
 * upserts trading_venues + appends trading_venue_versions on change
 * (lib/db/instruments.ts:upsertVenue — version-diff driven, derivation
 * provenance recorded).
 * Filtering: with --mics only those MICs are imported (V1 seed scope);
 * without it, all MICs in the file are imported.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseIsoMicCsv } from "../../lib/instruments.ts";
import { upsertVenue } from "../../lib/db/instruments.ts";
import { connectDb, observe } from "./lib.mts";

const OFFICIAL_CSV =
  "https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv";

const args = process.argv.slice(2);
const argOf = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = argOf("--file");
const onlyMics = argOf("--mics")
  ?.split(",")
  .map((s) => s.trim().toUpperCase());

async function loadCsv(): Promise<{ text: string; sourceUrl: string }> {
  if (file)
    return { text: readFileSync(file, "utf8"), sourceUrl: `file://${file}` };
  const res = await fetch(OFFICIAL_CSV, {
    headers: { "User-Agent": "ThunderFeed-instrument-master/1.0" },
  });
  if (!res.ok) throw new Error(`ISO 10383 CSV → HTTP ${res.status}`);
  return { text: await res.text(), sourceUrl: OFFICIAL_CSV };
}

const { text, sourceUrl } = await loadCsv();
const fileHash = createHash("sha256").update(text).digest("hex");
const rows = parseIsoMicCsv(text).filter(
  (r) => !onlyMics || onlyMics.includes(r.mic),
);
console.log(
  `ISO 10383 snapshot sha256=${fileHash.slice(0, 16)}… rows=${rows.length}`,
);

const c = connectDb();
await c.connect();
try {
  await c.query("BEGIN");
  let created = 0,
    appended = 0,
    unchanged = 0;
  for (const v of rows) {
    const obsId = await observe(c, {
      provider: "iso_10383",
      dataset: "mic_list",
      recordKey: v.mic,
      sourceUrl,
      observedAt: v.validFrom ?? undefined,
      payload: { file_sha256: fileHash, row: v },
    });
    const r = await upsertVenue(c, v, obsId);
    if (r.action === "created") created++;
    else if (r.action === "version_appended") appended++;
    else unchanged++;
  }
  await c.query("COMMIT");
  console.log(
    `venues: created=${created} versions_appended=${appended} unchanged=${unchanged}`,
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
