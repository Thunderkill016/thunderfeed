/* SEC EDGAR adapter — company_tickers_exchange.json as registry observations.
 *
 *   npx tsx scripts/instruments/import-sec.mts
 *
 * SEC's file associates CIK↔name↔ticker↔exchange-name. Per SEC it is
 * periodically updated without accuracy guarantees → stored as observations
 * only (discovery source), never promoted to master state on its own.
 * CIK remains an entity identifier; the adapter never writes
 * entity_identifiers.
 */
import { parseSecTickersExchange } from "../../lib/instruments.ts";
import { connectDb, fetchJson, observe } from "./lib.mts";

const SEC_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const UA = {
  "User-Agent": "ThunderFeed instrument-master (research; contact via repo)",
};

const c = connectDb();
await c.connect();
try {
  const payload = await fetchJson(SEC_URL, UA);
  const rows = parseSecTickersExchange(payload);
  let inserted = 0;
  await c.query("BEGIN");
  for (const r of rows) {
    const before = await observe(c, {
      provider: "sec_edgar",
      dataset: "company_tickers_exchange",
      recordKey: `${String(r.cik).padStart(10, "0")}:${r.ticker}`,
      sourceUrl: SEC_URL,
      payload: r,
    });
    if (before) inserted++;
  }
  await c.query("COMMIT");
  console.log(
    `sec_edgar company_tickers_exchange: ${rows.length} rows observed`,
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
