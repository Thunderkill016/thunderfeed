/* One-off verification: alt-asset series state after import-altassets. */
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

const c = connectDb();
await c.connect();
const r = await c.query(
  `SELECT lv.ticker, iv.asset_class, ms.provider, ms.price_basis,
          count(mp.id) pts, max(mp.session_date) last,
          (SELECT v.close FROM market_point_versions v
             JOIN market_points p ON p.current_version_id=v.id
            WHERE p.series_id=ms.id ORDER BY p.session_date DESC LIMIT 1) last_close
     FROM market_series ms
     JOIN instrument_listings il ON il.id=ms.listing_id
     JOIN listing_versions lv ON lv.id=il.current_version_id
     JOIN financial_instruments fi ON fi.id=il.instrument_id
     JOIN instrument_versions iv ON iv.id=fi.current_version_id
     LEFT JOIN market_points mp ON mp.series_id=ms.id
    WHERE ms.provider IN ('giavang','binance','er_api','derived')
    GROUP BY 1,2,3,4,ms.id ORDER BY 2,1`,
);
for (const x of r.rows)
  console.log(
    String(x.asset_class).padEnd(9),
    String(x.ticker).padEnd(9),
    String(x.provider).padEnd(8),
    String(x.price_basis).padEnd(14),
    `pts:${String(x.pts).padEnd(4)}`,
    x.last,
    `close:${x.last_close}`,
  );
const d = await c.query(
  `SELECT kind, count(*) n FROM data_deltas GROUP BY 1 ORDER BY 1`,
);
console.log("deltas:", JSON.stringify(d.rows));
const s = await c.query(
  `SELECT status, count(*) n FROM signal_outcomes GROUP BY 1`,
);
console.log("signal_outcomes:", JSON.stringify(s.rows));
await c.end();
