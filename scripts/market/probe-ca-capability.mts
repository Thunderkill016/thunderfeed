/* Corporate-action capability probe — ONE request per endpoint for one
 * ticker (AAPL). Prints HTTP status + structural shape only; credentials
 * never leave memory and never enter output.
 *
 *   npx tsx scripts/market/probe-ca-capability.mts [TICKER]
 */
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const ticker = process.argv[2] ?? "AAPL";
const avKey = process.env.ALPHAVANTAGE_API_KEY;
const tiToken = process.env.TIINGO_API_TOKEN;

function classify(status: number, body: string): string {
  if (status === 401 || status === 403) return "unauthorized/entitlement";
  if (status === 404) return "invalid_symbol_or_path";
  if (status === 429) return "rate_limited";
  if (status < 200 || status >= 300) return `api_error:${status}`;
  const t = body.trim();
  if (!t) return "empty";
  if (/rate limit|premium|frequency/i.test(t.slice(0, 300)))
    return "rate_limited_or_entitlement";
  return "available";
}

async function probe(
  name: string,
  url: string,
  headers?: Record<string, string>,
) {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    // shape only — keys/header row, never payload volume
    const head = body.trim().split("\n")[0]?.slice(0, 200);
    let shape = "";
    try {
      const j = JSON.parse(body);
      shape = Array.isArray(j)
        ? `json array len=${j.length} keys=${j[0] ? Object.keys(j[0]).join(",") : "-"}`
        : `json obj keys=${Object.keys(j).join(",")}`;
    } catch {
      shape = `non-json header: ${head}`;
    }
    console.log(
      `${name.padEnd(34)} ${String(res.status).padEnd(4)} ${classify(res.status, body).padEnd(26)} ${shape}`,
    );
  } catch (e) {
    console.log(
      `${name.padEnd(34)} ERR   ${(e as Error).message.slice(0, 80)}`,
    );
  }
}

if (avKey) {
  await probe(
    "alpha DIVIDENDS",
    `https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${encodeURIComponent(ticker)}&apikey=${avKey}`,
  );
  await probe(
    "alpha SPLITS",
    `https://www.alphavantage.co/query?function=SPLITS&symbol=${encodeURIComponent(ticker)}&apikey=${avKey}`,
  );
} else console.log("alpha: ALPHAVANTAGE_API_KEY absent");

if (tiToken) {
  const h = { Authorization: `Token ${tiToken}` };
  await probe(
    "tiingo distributions",
    `https://api.tiingo.com/tiingo/corporate-actions/${encodeURIComponent(ticker)}/distributions`,
    h,
  );
  await probe(
    "tiingo splits",
    `https://api.tiingo.com/tiingo/corporate-actions/${encodeURIComponent(ticker)}/splits`,
    h,
  );
} else console.log("tiingo: TIINGO_API_TOKEN absent");
