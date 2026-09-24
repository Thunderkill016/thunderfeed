/**
 * SEC EDGAR adapter — official public JSON, no key.
 * data.sec.gov/submissions/CIK{10}.json returns a company's recent filings;
 * we emit one Article per material filing so an 8-K can become primary
 * evidence for claims about the issuer.
 *
 * P0 universe is bounded to the large tech/AI issuers ThunderFeed already
 * tracks — this is not a whole-market crawler.
 */
import { createHash } from "node:crypto";
import { safeUrl } from "../news";
import type { Article, SourceStatus } from "../model";

const FETCH_TIMEOUT = 12_000;
const MAX_FILINGS_PER_ISSUER = 5;
const MAX_FILING_AGE = 14 * 24 * 60 * 60_000;

// SEC fair-access requires a declared UA with contact email — requests
// without one get 403s at any rate, not just under load.
const SEC_UA = "ThunderFeed dev@thunderfeed.app";

const PRIORITY_FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-K", "6-K", "20-F"]);

/** CIK universe — padded 10-digit, keyed for the submissions endpoint. */
const ISSUERS: { name: string; cik: string }[] = [
  { name: "Apple Inc.", cik: "0000320193" },
  { name: "Microsoft Corp.", cik: "0000789019" },
  { name: "Alphabet Inc.", cik: "0001652044" },
  { name: "Meta Platforms, Inc.", cik: "0001326801" },
  { name: "NVIDIA Corp.", cik: "0001045810" },
  { name: "Amazon.com, Inc.", cik: "0001018724" },
  { name: "Tesla, Inc.", cik: "0001318605" },
  { name: "Advanced Micro Devices, Inc.", cik: "0000002488" },
  { name: "Intel Corp.", cik: "0000050863" },
  { name: "Oracle Corp.", cik: "0001341439" },
];

interface RecentFilings {
  form: string[];
  filingDate: string[];
  reportDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

interface Submissions {
  name?: string;
  filings?: { recent?: RecentFilings };
}

/** Map an issuer's submissions JSON to filing Articles — pure, testable. */
export function filingsToArticles(
  issuer: { name: string; cik: string },
  data: Submissions,
  now: number = Date.now(),
): Article[] {
  const out: Article[] = [];
  const r = data.filings?.recent;
  if (!r) return out;
  let kept = 0;
  for (let i = 0; i < r.form.length && kept < MAX_FILINGS_PER_ISSUER; i++) {
    if (!PRIORITY_FORMS.has(r.form[i])) continue;
    const filed = Date.parse(r.filingDate[i] ?? "");
    if (!Number.isFinite(filed) || now - filed > MAX_FILING_AGE) continue;
    const accession = r.accessionNumber[i];
    const accessionKey = accession.replace(/-/g, "");
    const primaryDoc = r.primaryDocument[i];
    const url = safeUrl(
      `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accessionKey}/${primaryDoc}`,
    );
    if (!url) continue;
    const issuerName = data.name ?? issuer.name;
    const structuredData = {
      cik: issuer.cik,
      accession,
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i] || undefined,
      primaryDocument: primaryDoc,
      issuer: issuerName,
    };
    out.push({
      id: createHash("sha256").update(accession).digest("hex").slice(0, 20),
      title: `${issuerName} — ${r.form[i]} filing`,
      summary:
        `SEC filing ${r.form[i]} filed ${r.filingDate[i]}` +
        (r.reportDate[i] ? ` for period ${r.reportDate[i]}` : "") +
        ` (accession ${accession}).`,
      url,
      image: null,
      publishedAt: new Date(filed).toISOString(),
      source: issuerName,
      topic: "business",
      headline: false,
      appearances: [{ source: issuerName, url }],
      language: "en",
      region: "us",
      wire: false,
      ingest: {
        sourceKind: "primary",
        discoveredVia: "official_api",
        discoveryProvider: "SEC EDGAR",
        sourceDomain: "sec.gov",
        externalId: accession,
        documentType: "filing",
        structuredData,
      },
    });
    kept++;
  }
  return out;
}

export async function fetchSecEdgar(): Promise<{
  articles: Article[];
  status: SourceStatus;
}> {
  const checkedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = {
    id: "sec-edgar",
    name: "SEC EDGAR",
    topic: "business" as const,
    url: "https://www.sec.gov/edgar",
    checkedAt,
  };
  const now = Date.now();
  const articles: Article[] = [];
  let httpStatus: number | undefined;
  let issuersFailed = 0;
  try {
    for (const issuer of ISSUERS) {
      const res = await fetch(
        `https://data.sec.gov/submissions/CIK${issuer.cik}.json`,
        {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
          headers: { "User-Agent": SEC_UA, Accept: "application/json" },
        },
      );
      httpStatus = res.status;
      if (res.status === 429) throw new Error("HTTP 429");
      if (!res.ok) {
        issuersFailed++; // one bad issuer must not sink the adapter
        continue;
      }
      const data = (await res.json()) as Submissions;
      articles.push(...filingsToArticles(issuer, data, now));
    }
    // "empty" is reserved for a genuinely filing-free window — if every
    // issuer request was refused the upstream is unhealthy, not quiet.
    const status =
      issuersFailed === ISSUERS.length
        ? httpStatus === 403 || httpStatus === 429
          ? ("rate_limited" as const)
          : ("error" as const)
        : articles.length
          ? ("ok" as const)
          : ("empty" as const);
    return {
      articles,
      status: {
        ...base,
        latencyMs: Date.now() - t0,
        httpStatus,
        status,
        count: articles.length,
        error:
          status === "empty" || status === "ok"
            ? undefined
            : `all ${issuersFailed} issuer fetches failed (HTTP ${httpStatus})`,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Fetch failed";
    return {
      articles: [],
      status: {
        ...base,
        latencyMs: Date.now() - t0,
        httpStatus: /429/.test(msg) ? 429 : httpStatus,
        status: /429/.test(msg) ? "rate_limited" : "error",
        count: 0,
        error: msg.slice(0, 140),
      },
    };
  }
}
