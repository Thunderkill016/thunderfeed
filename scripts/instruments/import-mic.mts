/* ISO 10383 MIC importer — official SWIFT RA dataset, never seeded from memory.
 *
 *   npx tsx scripts/instruments/import-mic.mts [--file /path/mic.csv] [--mics XNAS,XNYS]
 *
 * Downloads the official CSV, stores one reference_observation per imported
 * MIC row (dataset 'mic_list', payload = raw parsed row + file hash), then
 * upserts trading_venues + appends trading_venue_versions on change.
 * Filtering: with --mics only those MICs are imported (V1 seed scope);
 * without it, all ACTIVE operating/segment MICs are imported.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseIsoMicCsv, type MicRow } from "../../lib/instruments.ts";
import { connectDb, contentHash, observe } from "./lib.mts";

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

async function upsertVenue(c: import("pg").Client, v: MicRow, obsId: string) {
  const cur = await c.query(
    `SELECT tv.id AS venue_id, tv.current_version_id,
            tvv.version_no,
            tvv.market_name, tvv.legal_entity_name, tvv.lei,
            tvv.country_code, tvv.city, tvv.operating_mic, tvv.mic_role,
            tvv.market_category, tvv.acronym, tvv.status,
            tvv.valid_from, tvv.valid_to
       FROM trading_venues tv
       LEFT JOIN trading_venue_versions tvv ON tvv.id = tv.current_version_id
      WHERE tv.mic = $1`,
    [v.mic],
  );
  const attrs = {
    market_name: v.marketName,
    legal_entity_name: v.legalEntityName,
    lei: v.lei,
    country_code: v.countryCode,
    city: v.city,
    operating_mic: v.operatingMic,
    mic_role: v.micRole,
    market_category: v.marketCategory,
    acronym: v.acronym,
    status: v.status,
    valid_from: v.validFrom,
    valid_to: v.validTo,
  };
  const row = cur.rows[0];
  const cell = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "");
  const unchanged =
    row?.venue_id &&
    Object.entries(attrs).every(
      ([k, val]) => cell(row[k]) === String(val ?? ""),
    );
  if (unchanged) return { mic: v.mic, action: "unchanged" };

  let venueId = row?.venue_id as string | undefined;
  if (!venueId) {
    const ins = await c.query(
      `INSERT INTO trading_venues (mic, status) VALUES ($1,$2) RETURNING id`,
      [v.mic, v.status],
    );
    venueId = ins.rows[0].id;
  }
  const nextNo = row?.version_no == null ? 1 : (row.version_no as number) + 1;
  const ver = await c.query(
    `INSERT INTO trading_venue_versions
       (venue_id, version_no, market_name, legal_entity_name, lei,
        country_code, city, operating_mic, mic_role, market_category,
        acronym, status, valid_from, valid_to, observation_id,
        previous_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      venueId,
      nextNo,
      attrs.market_name,
      attrs.legal_entity_name,
      attrs.lei,
      attrs.country_code,
      attrs.city,
      attrs.operating_mic,
      attrs.mic_role,
      attrs.market_category,
      attrs.acronym,
      attrs.status,
      attrs.valid_from,
      attrs.valid_to,
      obsId,
      row?.current_version_id ?? null,
    ],
  );
  await c.query(
    `UPDATE trading_venues SET current_version_id=$1, status=$2 WHERE id=$3`,
    [ver.rows[0].id, v.status, venueId],
  );
  return {
    mic: v.mic,
    action: row ? "version_appended" : "created",
    version: nextNo,
  };
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
