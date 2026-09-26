/* OpenFIGI adapter — /v3/mapping jobs for SEC-discovered (ticker, MIC) pairs.
 *
 *   npx tsx scripts/instruments/import-openfigi.mts
 *
 * For every SEC observation whose exchange maps to a known MIC, POST a
 * mapping job {idType:'TICKER', idValue, micCode}. Each job+response is one
 * reference_observation (dataset 'mapping_v3', record_key '<mic>:<ticker>').
 * Rate limits honored: 10 jobs/request unauthenticated, 25 req/min;
 * 429 → wait ratelimit-reset seconds, never partial-commit.
 */
import { SEC_EXCHANGE_MIC_CANDIDATES } from "../../lib/instruments.ts";
import { connectDb, observe } from "./lib.mts";

const API = "https://api.openfigi.com/v3/mapping";
const JOBS_PER_REQUEST = 10; // unauthenticated limit
const REQUEST_INTERVAL_MS = 2600; // 25/min ≈ 2.4s — pad for safety

interface Job {
  idType: string;
  idValue: string;
  micCode: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJobs(jobs: Job[]): Promise<unknown[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.OPENFIGI_API_KEY)
    headers["X-OPENFIGI-APIKEY"] = process.env.OPENFIGI_API_KEY;
  for (;;) {
    const res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify(jobs),
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get("ratelimit-reset") ?? "60");
      console.log(`  429 rate-limited — waiting ${reset}s`);
      await sleep(reset * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`OpenFIGI ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

const c = connectDb();
await c.connect();
try {
  // Seed universe = entities that already carry a CIK identifier.
  // OpenFIGI jobs are limited to those issuers' ticker×MIC pairs —
  // we do not map the whole market in V1.
  const seedCiks = await c.query(
    `SELECT DISTINCT value FROM entity_identifiers WHERE scheme='cik'`,
  );
  const cikSet = new Set(seedCiks.rows.map((r) => r.value as string));

  const secs = await c.query(
    `SELECT payload FROM reference_observations
      WHERE provider='sec_edgar' AND dataset='company_tickers_exchange'`,
  );
  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const r of secs.rows) {
    const p = r.payload as { cik: number; ticker: string; exchange: string };
    if (!cikSet.has(String(p.cik).padStart(10, "0"))) continue;
    for (const mic of SEC_EXCHANGE_MIC_CANDIDATES[p.exchange] ?? []) {
      const key = `${mic}:${p.ticker}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ idType: "TICKER", idValue: p.ticker, micCode: mic });
    }
  }
  console.log(`openfigi jobs: ${jobs.length} (ticker×mic pairs)`);

  await c.query("BEGIN");
  let stored = 0;
  for (let i = 0; i < jobs.length; i += JOBS_PER_REQUEST) {
    const batch = jobs.slice(i, i + JOBS_PER_REQUEST);
    const entries = await postJobs(batch);
    for (let j = 0; j < batch.length; j++) {
      await observe(c, {
        provider: "openfigi",
        dataset: "mapping_v3",
        recordKey: `${batch[j].micCode}:${batch[j].idValue}`,
        sourceUrl: API,
        payload: { job: batch[j], response: entries[j] },
      });
      stored++;
    }
    if (i + JOBS_PER_REQUEST < jobs.length) await sleep(REQUEST_INTERVAL_MS);
  }
  await c.query("COMMIT");
  console.log(`openfigi observations stored: ${stored}`);
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
