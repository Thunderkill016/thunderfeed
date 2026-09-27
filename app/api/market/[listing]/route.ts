import { NextResponse } from "next/server";
import { dbEnabled, getPool } from "../../../../lib/db/pool";
import {
  getDailyBarsForListing,
  getMarketSeriesForListing,
} from "../../../../lib/db/read";
import { isCalendarDate } from "../../../../lib/market";

/* Read-only market data by stable listing identity:
 *   /api/market/<listing uuid|listing:canonical_key>
 *     ?provider=alphavantage&dataset=time_series_daily&priceBasis=as_traded
 *     &from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1..5000&order=asc|desc
 *
 * A bare ticker is NOT an identity here — tickers rename; listings don't.
 * Bars are always returned under their explicit series identity, never
 * merged across providers. */
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ listing: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { listing } = await params;
  let key: string;
  try {
    key = decodeURIComponent(listing);
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const isKey = /^listing:[a-z0-9_:]{1,160}$/.test(key);
  if (!isUuid && !isKey) return NextResponse.json(null, { status: 404 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const provider = url.searchParams.get("provider") ?? undefined;
  const dataset = url.searchParams.get("dataset") ?? undefined;
  const priceBasis = url.searchParams.get("priceBasis") ?? undefined;
  const limitP = url.searchParams.get("limit");
  const order = url.searchParams.get("order") ?? "desc";

  if (from != null && !isCalendarDate(from))
    return bad("from must be a real calendar date YYYY-MM-DD");
  if (to != null && !isCalendarDate(to))
    return bad("to must be a real calendar date YYYY-MM-DD");
  if (from != null && to != null && from > to) return bad("from > to");
  let limit: number | undefined;
  if (limitP != null) {
    if (!/^\d+$/.test(limitP)) return bad("limit must be an integer 1..5000");
    limit = Number(limitP);
    if (limit < 1 || limit > 5000)
      return bad("limit must be an integer 1..5000");
  }
  if (order !== "asc" && order !== "desc") return bad("order must be asc|desc");

  const pool = getPool();
  const l = await pool.query<{ id: string; canonical_key: string }>(
    isUuid
      ? `SELECT id, canonical_key FROM instrument_listings WHERE id = $1`
      : `SELECT id, canonical_key FROM instrument_listings
          WHERE canonical_key = $1`,
    [key],
  );
  const row = l.rows[0];
  if (!row) return NextResponse.json(null, { status: 404 });

  const selected = await getDailyBarsForListing(row.id, {
    provider,
    dataset,
    priceBasis,
    from: from ?? undefined,
    to: to ?? undefined,
    limit,
    order,
  });
  if (!selected)
    return NextResponse.json(
      {
        listing: { id: row.id, canonicalKey: row.canonical_key },
        error:
          "no unique series matches — pass provider/dataset/priceBasis to select explicitly",
      },
      { status: 404 },
    );
  return NextResponse.json(
    {
      listing: { id: row.id, canonicalKey: row.canonical_key },
      series: selected.series,
      bars: selected.bars,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
