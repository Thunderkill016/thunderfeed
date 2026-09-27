/* World Bank macro importer — VN + EM Asia coverage, no API key.
 *
 *   npx tsx scripts/macro/import-worldbank.mts [--only VNM] [--dry-run]
 *
 * WB contract: /v2/country/{iso3}/indicator/{code}?format=json
 *   → [meta, [{indicator,country,date:"2024",value,...}]]
 * Annual series; value null = unknown (skipped, never minted as 0).
 *
 * WB exposes no vintage dates — vintageDate = fetch day, applied in
 * stableVintage mode so a rerun carrying identical values writes
 * nothing; only a real value change mints a revision version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseWorldBankObservations } from "../../lib/macro.ts";
import {
  applyMacroObservations,
  getOrCreateMacroSeries,
} from "../../lib/db/macro.ts";
import { connectDb, observe } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const ONLY = opt("only"); // iso3 filter, e.g. VNM

/* Indicator universe — canonical WB codes with display metadata. */
const INDICATORS: { code: string; title: string; units: string }[] = [
  { code: "NY.GDP.MKTP.CD", title: "GDP (current US$)", units: "US$" },
  { code: "NY.GDP.MKTP.KD.ZG", title: "GDP growth", units: "percent" },
  { code: "FP.CPI.TOTL.ZG", title: "Inflation, CPI", units: "percent" },
  {
    code: "SL.UEM.TOTL.ZS",
    title: "Unemployment, total",
    units: "percent of labor force",
  },
  {
    code: "NE.EXP.GNFS.ZS",
    title: "Exports of goods & services",
    units: "percent of GDP",
  },
  {
    code: "BX.KLT.DINV.WD.GD.ZS",
    title: "FDI, net inflows",
    units: "percent of GDP",
  },
  { code: "SP.POP.TOTL", title: "Population, total", units: "persons" },
];

/* iso3 → canonical entity key (all confirmed present in entities). */
const COUNTRIES: Record<string, { name: string; entity: string }> = {
  VNM: { name: "Vietnam", entity: "country:vietnam" },
  THA: { name: "Thailand", entity: "country:thailand" },
  IDN: { name: "Indonesia", entity: "country:indonesia" },
  MYS: { name: "Malaysia", entity: "country:malaysia" },
  PHL: { name: "Philippines", entity: "country:philippines" },
  KHM: { name: "Cambodia", entity: "country:cambodia" },
  LAO: { name: "Laos", entity: "country:laos" },
  MMR: { name: "Myanmar", entity: "country:myanmar" },
  IND: { name: "India", entity: "country:india" },
  CHN: { name: "China", entity: "country:china" },
  KOR: { name: "South Korea", entity: "country:south_korea" },
  JPN: { name: "Japan", entity: "country:japan" },
  SGP: { name: "Singapore", entity: "country:singapore" },
};

const dbUrl =
  opt("db") ||
  (process.env.DATABASE_URL?.includes("supabase")
    ? process.env.DATABASE_URL
    : process.env.SUPABASE_DB_PASS
      ? `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(
          process.env.SUPABASE_DB_PASS,
        )}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
      : undefined);
if (!dbUrl) throw new Error("DATABASE_URL or SUPABASE_DB_PASS required");
const c = connectDb(dbUrl);
await c.connect();

const VINTAGE = new Date().toISOString().slice(0, 10);
const audit: {
  generatedAt: string;
  runs: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = { generatedAt: new Date().toISOString(), runs: [], metrics: {} };

let requested = 0;
let successful = 0;
let providerErrors = 0;
let totalPoints = 0;
let totalVersions = 0;
let totalUnchanged = 0;
const errors: { series: string; detail: string }[] = [];

for (const [iso3, country] of Object.entries(COUNTRIES)) {
  if (ONLY && iso3 !== ONLY) continue;
  for (const ind of INDICATORS) {
    requested++;
    const seriesCode = `${iso3}:${ind.code}`;
    const url =
      `https://api.worldbank.org/v2/country/${iso3}/indicator/` +
      `${ind.code}?format=json&per_page=20000`;
    let payload: unknown = null;
    let status = 0;
    try {
      const res = await fetch(url);
      status = res.status;
      payload = await res.json();
    } catch (e) {
      providerErrors++;
      errors.push({
        series: seriesCode,
        detail: `fetch: ${(e as Error).message.slice(0, 160)}`,
      });
      continue;
    }
    const obsId = DRY_RUN
      ? "dry"
      : await observe(c, {
          provider: "worldbank",
          dataset: "series_observations",
          recordKey: `worldbank:${seriesCode}`,
          sourceUrl: url,
          payload,
        });
    if (status !== 200 || !Array.isArray(payload)) {
      providerErrors++;
      errors.push({
        series: seriesCode,
        detail: `http ${status}: ${JSON.stringify(payload)?.slice(0, 160)}`,
      });
      continue;
    }
    const parsed = parseWorldBankObservations(payload, VINTAGE);
    if (parsed.kind === "error") {
      providerErrors++;
      errors.push({ series: seriesCode, detail: parsed.detail });
      continue;
    }
    if (DRY_RUN) {
      audit.runs.push({
        series: seriesCode,
        obs: parsed.kind === "observations" ? parsed.observations.length : 0,
        dryRun: true,
      });
      successful++;
      continue;
    }
    await c.query("BEGIN");
    try {
      const e = await c.query(
        `SELECT id FROM entities WHERE canonical_key=$1`,
        [country.entity],
      );
      const seriesId = await getOrCreateMacroSeries(c, {
        provider: "worldbank",
        seriesCode,
        meta: {
          seriesCode,
          title: `${ind.title} — ${country.name}`,
          frequency: "Annual",
          frequencyShort: "A",
          units: ind.units,
          seasonalAdjustment: null,
          notes: null,
        },
        entityId: (e.rows[0]?.id as string) ?? null,
      });
      const r =
        parsed.kind === "empty"
          ? { pointsInserted: 0, versionsInserted: 0, unchanged: 0 }
          : await applyMacroObservations(
              c,
              seriesId,
              parsed.observations,
              obsId,
              { stableVintage: true },
            );
      totalPoints += r.pointsInserted;
      totalVersions += r.versionsInserted;
      totalUnchanged += r.unchanged;
      await c.query("COMMIT");
      successful++;
      audit.runs.push({
        series: seriesCode,
        obs: parsed.kind === "observations" ? parsed.observations.length : 0,
        points: r.pointsInserted,
        versions: r.versionsInserted,
        unchanged: r.unchanged,
      });
    } catch (e2) {
      await c.query("ROLLBACK");
      providerErrors++;
      errors.push({
        series: seriesCode,
        detail: `apply: ${(e2 as Error).message.slice(0, 160)}`,
      });
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
}

audit.metrics = {
  provider: "worldbank",
  requested,
  successful,
  providerErrors,
  totalPoints,
  totalVersions,
  totalUnchanged,
  errors,
};
await c.end();
writeFileSync(
  "bench/macro-worldbank-v1-audit.json",
  JSON.stringify(audit, null, 2),
);
console.log(
  `worldbank: requested=${requested} ok=${successful} ` +
    `errors=${providerErrors} points=${totalPoints} ` +
    `versions=${totalVersions} unchanged=${totalUnchanged}`,
);
