/* FRED macro importer — Macro Foundation V1.
 *
 *   npx tsx scripts/macro/import-fred.mts [--series CPIAUCSL] [--dry-run]
 *
 * Flow per series code:
 *   GET fred/series (meta) → reference_observations FIRST →
 *   get-or-create macro_series → GET fred/series/observations →
 *   reference_observations FIRST → one transaction → vintage-keyed
 *   append-only versions via applyMacroObservations.
 *
 * FRED contract (public API):
 *   series            → {seriess: [{id,title,frequency,units,...}]}
 *   series/observations → {observations:[{date,value,realtime_start,...}]}
 *   errors            → {error_code,error_message}; value '.' = missing
 *
 * Latest-vintage history per call; a future revision arrives as the same
 * obs_date with a new realtime_start → new version (history kept).
 * Full ALFRED vintage enumeration (series/vintagedates) is a later phase.
 *
 * Requires FRED_API_KEY — free at fredaccount.stlouisfed.org; never logged
 * or stored (scrubbed from payloads before observe()).
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  classifyFredResponse,
  parseFredObservations,
  parseFredSeriesMeta,
} from "../../lib/macro.ts";
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
const ONLY = opt("series");
const LIMIT = opt("limit") ? Number(opt("limit")) : null;

/* V1 universe — the macro core of "how the world economy runs".
 * code → scope entity canonical_key candidates (first match wins). */
const UNIVERSE: { code: string; scope?: string[] }[] = [
  // US activity
  {
    code: "GDPC1",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "INDPRO",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "RSAFS",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "HOUST",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  // US inflation / labour
  {
    code: "CPIAUCSL",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "PCEPILFE",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "UNRATE",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "PAYEMS",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  // Fed / rates / money
  {
    code: "FEDFUNDS",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "DGS2",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "DGS10",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "T10Y2Y",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "T10YIE",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "M2SL",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "WALCL",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  // markets / risk
  { code: "SP500" },
  { code: "VIXCLS" },
  { code: "BAMLH0A0HYM2" },
  { code: "DCOILWTICO" },
  // gold omitted — FRED's LBMA fix series (GOLDAM/PMGBD228NLBM) discontinued
  { code: "DTWEXBGS" },
  // consumer / housing
  {
    code: "UMCSENT",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  {
    code: "MORTGAGE30US",
    scope: ["country:united_states", "country:us", "country:usa"],
  },
  // FX — global economy lens
  { code: "DEXUSEU" }, // EUR/USD
  { code: "DEXJPUS" }, // JPY/USD
  { code: "DEXCHUS" }, // CNY/USD
  // non-US policy + inflation (IMF annual via FRED)
  { code: "ECBDFR", scope: ["country:euro_area", "region:euro_area"] },
  { code: "FPCPITOTLZGCHN", scope: ["country:china"] },
  { code: "FPCPITOTLZGJPN", scope: ["country:japan"] },
  { code: "FPCPITOTLZGDEU", scope: ["country:germany"] },
  { code: "FPCPITOTLZGGBR", scope: ["country:united_kingdom", "country:uk"] },
];

const apiKey = process.env.FRED_API_KEY;
if (!apiKey) {
  console.error(
    "FRED_API_KEY not set — production ingestion stops here. Adapters " +
      "and tests are complete; no unofficial source is substituted.",
  );
  process.exit(2);
}

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

const audit: {
  generatedAt: string;
  runs: Record<string, unknown>[];
  metrics: Record<string, unknown>;
} = { generatedAt: new Date().toISOString(), runs: [], metrics: {} };

let requested = 0;
let successful = 0;
let providerErrors = 0;
let rateLimited = 0;
let invalidSeries = 0;
let observations = 0;
let totalPoints = 0;
let totalVersions = 0;
let totalUnchanged = 0;
const errors: { series: string; kind: string; detail: string }[] = [];

const fred = async (path: string, params: Record<string, string>) => {
  const url =
    `https://api.stlouisfed.org/fred/${path}?api_key=${apiKey}` +
    `&file_type=json` +
    Object.entries(params)
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join("");
  const res = await fetch(url);
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body — classified by status below */
  }
  // FRED echoes nothing sensitive, but scrub the key defensively before
  // the payload can be persisted (Alpha echoed keys in rate-limit bodies)
  const asText = JSON.stringify(payload);
  if (apiKey && asText.includes(apiKey))
    payload = JSON.parse(asText.replaceAll(apiKey, "[REDACTED]"));
  return {
    status: res.status,
    payload,
    urlForEvidence: url.replace(apiKey, "[REDACTED]"),
  };
};

for (const { code, scope } of UNIVERSE) {
  if (ONLY && code !== ONLY) continue;
  if (LIMIT && requested >= LIMIT) break;
  requested++;

  // 1) series meta → evidence → canonical macro_series
  const metaRes = await fred("series", { series_id: code });
  const metaCls = classifyFredResponse(metaRes.status, metaRes.payload);
  const metaObsId = DRY_RUN
    ? "dry"
    : await observe(c, {
        provider: "fred",
        dataset: "series_meta",
        recordKey: `fred:${code}`,
        sourceUrl: metaRes.urlForEvidence,
        payload: metaRes.payload,
      });
  observations++;
  if (metaCls !== "ok") {
    providerErrors++;
    if (metaCls === "rate_limited") rateLimited++;
    if (metaCls === "invalid_series") invalidSeries++;
    errors.push({
      series: code,
      kind: metaCls,
      detail: JSON.stringify(metaRes.payload).slice(0, 200),
    });
    continue;
  }
  const metaParsed = parseFredSeriesMeta(metaRes.payload);
  if (metaParsed.kind !== "meta") {
    providerErrors++;
    errors.push({
      series: code,
      kind: "unexpected_schema",
      detail: metaParsed.detail,
    });
    continue;
  }

  // 2) observations → evidence
  const obsRes = await fred("series/observations", {
    series_id: code,
    sort_order: "asc",
  });
  const obsCls = classifyFredResponse(obsRes.status, obsRes.payload);
  const obsObsId = DRY_RUN
    ? "dry"
    : await observe(c, {
        provider: "fred",
        dataset: "series_observations",
        recordKey: `fred:${code}`,
        sourceUrl: obsRes.urlForEvidence,
        payload: obsRes.payload,
      });
  observations++;
  if (obsCls !== "ok") {
    providerErrors++;
    if (obsCls === "rate_limited") rateLimited++;
    errors.push({
      series: code,
      kind: obsCls,
      detail: JSON.stringify(obsRes.payload).slice(0, 200),
    });
    continue;
  }
  const parsed = parseFredObservations(obsRes.payload);
  if (parsed.kind === "error") {
    providerErrors++;
    errors.push({
      series: code,
      kind: "unexpected_schema",
      detail: parsed.detail,
    });
    continue;
  }
  if (parsed.kind === "empty") {
    audit.runs.push({ series: code, observations: 0 });
    successful++;
    continue;
  }

  if (DRY_RUN) {
    audit.runs.push({
      series: code,
      title: metaParsed.meta.title,
      observations: parsed.observations.length,
      first: parsed.observations[0].obsDate,
      last: parsed.observations[parsed.observations.length - 1].obsDate,
      dryRun: true,
    });
    successful++;
    continue;
  }

  await c.query("BEGIN");
  try {
    // entity scope: first matching canonical_key wins; absent → NULL
    let entityId: string | null = null;
    for (const key of scope ?? []) {
      const e = await c.query(
        `SELECT id FROM entities WHERE canonical_key=$1`,
        [key],
      );
      if (e.rows.length) {
        entityId = e.rows[0].id as string;
        break;
      }
    }
    const seriesId = await getOrCreateMacroSeries(c, {
      seriesCode: code,
      meta: metaParsed.meta,
      entityId,
    });
    const r = await applyMacroObservations(
      c,
      seriesId,
      parsed.observations,
      obsObsId,
    );
    totalPoints += r.pointsInserted;
    totalVersions += r.versionsInserted;
    totalUnchanged += r.unchanged;
    await c.query("COMMIT");
    successful++;
    audit.runs.push({
      series: code,
      title: metaParsed.meta.title,
      freq: metaParsed.meta.frequencyShort,
      units: metaParsed.meta.units,
      entityId,
      obs: parsed.observations.length,
      points: r.pointsInserted,
      versions: r.versionsInserted,
      unchanged: r.unchanged,
    });
  } catch (e) {
    await c.query("ROLLBACK");
    providerErrors++;
    errors.push({
      series: code,
      kind: "apply_error",
      detail: (e as Error).message.slice(0, 200),
    });
  }
  await new Promise((r2) => setTimeout(r2, 300));
}

audit.metrics = {
  provider: "fred",
  requested,
  successful,
  providerErrors,
  rateLimited,
  invalidSeries,
  observations,
  totalPoints,
  totalVersions,
  totalUnchanged,
  errors,
};
await c.end();
writeFileSync("bench/macro-fred-v1-audit.json", JSON.stringify(audit, null, 2));
console.log(
  `fred: requested=${requested} ok=${successful} errors=${providerErrors} ` +
    `rateLimited=${rateLimited} invalid=${invalidSeries} obs=${observations} ` +
    `points=${totalPoints} versions=${totalVersions} unchanged=${totalUnchanged}`,
);
