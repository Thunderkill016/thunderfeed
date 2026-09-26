/* Provenance proof — walks listing → series → point → version →
 * observation → raw payload for ONE overlapping session, both providers.
 * npx tsx scripts/market/prove-provenance.mts [YYYY-MM-DD] */
import { readFileSync } from "node:fs";
import { connectDb } from "../instruments/lib.mts";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may already be populated */
}

const dbUrl = process.env.DATABASE_URL?.includes("supabase")
  ? process.env.DATABASE_URL
  : `postgresql://postgres.vwpudirxzaxhbczknaan:${encodeURIComponent(
      process.env.SUPABASE_DB_PASS ?? "",
    )}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const c = connectDb(dbUrl);
await c.connect();

const date = process.argv[2];
const common = await c.query(
  `SELECT to_char(a.session_date,'YYYY-MM-DD') d
     FROM market_points a
     JOIN market_series sa ON sa.id=a.series_id AND sa.provider='alphavantage'
     JOIN market_series st ON st.listing_id=sa.listing_id AND st.provider='tiingo'
     JOIN market_points t ON t.series_id=st.id AND t.session_date=a.session_date
     JOIN instrument_listings l ON l.id=sa.listing_id
      AND l.canonical_key='listing:apple:common_stock:xngs'
    ORDER BY a.session_date DESC LIMIT 1`,
);
const sessionDate = date ?? common.rows[0]?.d;
if (!sessionDate) {
  console.log("no overlapping session found");
  await c.end();
  process.exit(1);
}
console.log(`overlapping session: ${sessionDate}\n`);

// listing identity
const li = await c.query(
  `SELECT l.id, l.canonical_key, i.canonical_key instrument,
          e.canonical_key issuer, lv.ticker, v.mic,
          (SELECT li2.value FROM listing_identifiers li2
            WHERE li2.listing_id = l.id AND li2.scheme = 'figi') figi
     FROM instrument_listings l
     JOIN financial_instruments i ON i.id = l.instrument_id
     JOIN entities e ON e.id = i.issuer_entity_id
     JOIN listing_versions lv ON lv.id = l.current_version_id
     JOIN trading_venues v ON v.id = l.venue_id
    WHERE l.canonical_key = 'listing:apple:common_stock:xngs'`,
);
console.log("listing:", JSON.stringify(li.rows[0], null, 1));

for (const provider of ["alphavantage", "tiingo"]) {
  const r = await c.query(
    `SELECT ms.id series_id, ms.canonical_key series_key,
            mp.id point_id, mp.session_date,
            v.id version_id, v.version_no,
            v.open::text o, v.high::text h, v.low::text lo,
            v.close::text cl, v.volume::text vol,
            v.observation_id, ro.dataset, ro.record_key,
            substring(ro.payload::text, 1, 0) _
       FROM market_series ms
       JOIN instrument_listings l ON l.id = ms.listing_id
       JOIN market_points mp ON mp.series_id = ms.id
       JOIN market_point_versions v ON v.id = mp.current_version_id
       JOIN reference_observations ro ON ro.id = v.observation_id
      WHERE l.canonical_key='listing:apple:common_stock:xngs'
        AND ms.provider=$1 AND mp.session_date=$2`,
    [provider, sessionDate],
  );
  const row = r.rows[0];
  if (!row) {
    console.log(`${provider}: NO ROW for ${sessionDate}`);
    continue;
  }
  console.log(
    `${provider}: series=${row.series_id}\n` +
      `  point=${row.point_id} version=${row.version_id} v${row.version_no}\n` +
      `  OHLCV = ${row.o} / ${row.h} / ${row.lo} / ${row.cl} / ${row.vol}\n` +
      `  observation=${row.observation_id} dataset=${row.dataset}\n` +
      `  record_key=${row.record_key}`,
  );
  // prove the raw payload actually contains this session's values
  const pl = await c.query(
    `SELECT payload::text p FROM reference_observations WHERE id=$1`,
    [row.observation_id],
  );
  const raw = pl.rows[0].p as string;
  let matchDesc: string;
  if (provider === "tiingo") {
    // raw CSV: find the line for the session date, compare fields
    const csv = JSON.parse(raw) as string;
    const lines = csv.split(/\r?\n/);
    const line = lines.find((l) => l.startsWith(sessionDate));
    matchDesc = line
      ? `raw CSV header: ${lines[0]}\n  raw CSV row: ${line}`
      : "RAW PAYLOAD MISSING SESSION LINE";
  } else {
    const obj = JSON.parse(raw) as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const ts = obj["Time Series (Daily)"]?.[sessionDate];
    matchDesc = ts
      ? `raw JSON bar: ${JSON.stringify(ts)}`
      : "RAW PAYLOAD MISSING SESSION KEY";
  }
  console.log(`  ${matchDesc}\n`);
}
await c.end();
