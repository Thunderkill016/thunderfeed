/* IMF DataMapper macro importer — VN + EM Asia + majors, no API key.
 *
 *   npx tsx scripts/macro/import-imf.mts [--only VNM] [--dry-run]
 *
 * IMF contract: /external/datamapper/api/v1/{indicator}/{iso3}
 *   → {values: {<code>: {<iso3>: {"2024": 6.1, ..., "2030": …}}}}
 * Out-years are WEO forecasts — a new WEO vintage re-values future
 * obs_dates, so forecast revisions land as real macro_revisions.
 *
 * IMF exposes no vintage dates — vintageDate = fetch day, applied in
 * stableVintage mode so a rerun carrying identical values writes
 * nothing; only a real value change mints a revision version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseImfDataMapper } from "../../lib/macro.ts";
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

/* Indicator universe — DataMapper codes. Out-year values are WEO
 * forecasts: this is the only provider that carries them, so these
 * series double as the forecast-vs-outcome surface. */
const INDICATORS: { code: string; title: string; units: string }[] = [
  { code: "NGDP_RPCH", title: "GDP growth (real)", units: "percent" },
  {
    code: "PCPIPCH",
    title: "Inflation, avg consumer prices",
    units: "percent",
  },
  { code: "LUR", title: "Unemployment rate", units: "percent" },
  {
    code: "BCA_NGDPD",
    title: "Current account balance",
    units: "percent of GDP",
  },
  {
    code: "GGXWDG_NGDP",
    title: "Government gross debt",
    units: "percent of GDP",
  },
  { code: "NID_NGDP", title: "Total investment", units: "percent of GDP" },
  {
    code: "NGSD_NGDP",
    title: "Gross national savings",
    units: "percent of GDP",
  },
  { code: "NGDPDPC", title: "GDP per capita", units: "US$" },
];

/* iso3 → canonical entity key (mirrors the World Bank importer). */
const COUNTRIES: Record<string, { name: string; entity: string }> = {
  VNM: { name: "Vietnam", entity: "country:vietnam" },
  THA: { name: "Thailand", entity: "country:thailand" },
  IDN: { name: "Indonesia", entity: "country:indonesia" },
  MYS: { name: "Malaysia", entity: "country:malaysia" },
  PHL: { name: "Philippines", entity: "country:philippines" },
  IND: { name: "India", entity: "country:india" },
  CHN: { name: "China", entity: "country:china" },
  KOR: { name: "South Korea", entity: "country:south_korea" },
  JPN: { name: "Japan", entity: "country:japan" },
  SGP: { name: "Singapore", entity: "country:singapore" },
  USA: { name: "United States", entity: "country:us" },
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
      `https://www.imf.org/external/datamapper/api/v1/` + `${ind.code}/${iso3}`;
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
          provider: "imf",
          dataset: "series_observations",
          recordKey: `imf:${seriesCode}`,
          sourceUrl: url,
          payload,
        });
    if (status !== 200) {
      providerErrors++;
      errors.push({
        series: seriesCode,
        detail: `http ${status}: ${JSON.stringify(payload)?.slice(0, 160)}`,
      });
      continue;
    }
    const parsed = parseImfDataMapper(payload, ind.code, iso3, VINTAGE);
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
        provider: "imf",
        seriesCode,
        meta: {
          seriesCode,
          title: `${ind.title} — ${country.name}`,
          frequency: "Annual",
          frequencyShort: "A",
          units: ind.units,
          seasonalAdjustment: null,
          notes: "IMF WEO; values after the latest actual are IMF forecasts.",
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
  provider: "imf",
  requested,
  successful,
  providerErrors,
  totalPoints,
  totalVersions,
  totalUnchanged,
  errors,
};
await c.end();
writeFileSync("bench/macro-imf-v1-audit.json", JSON.stringify(audit, null, 2));
console.log(
  `imf: requested=${requested} ok=${successful} ` +
    `errors=${providerErrors} points=${totalPoints} ` +
    `versions=${totalVersions} unchanged=${totalUnchanged}`,
);
