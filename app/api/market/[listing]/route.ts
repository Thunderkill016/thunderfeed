import { NextResponse } from "next/server";
import { dbEnabled, getPool } from "../../../../lib/db/pool";
import {
  getDailyBars,
  getMarketSeriesForListing,
} from "../../../../lib/db/read";

/* Read-only market data by stable listing identity:
 *   /api/market/<listing uuid|listing canonical_key>?from&to&limit&order
 * A bare ticker is NOT an identity here — tickers rename; listings don't.
 * Querying by ticker may become a convenience search endpoint later. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ listing: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { listing } = await params;
  const key = decodeURIComponent(listing);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const isKey = /^listing:[a-z0-9_:]{1,160}$/.test(key);
  if (!isUuid && !isKey) return NextResponse.json(null, { status: 404 });

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

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const limit = url.searchParams.get("limit");
  const order = url.searchParams.get("order");
  const dateOk = (s: string | undefined) =>
    s == null || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!dateOk(from) || !dateOk(to))
    return NextResponse.json(
      { error: "from/to must be YYYY-MM-DD" },
      { status: 400 },
    );

  const [series, bars] = await Promise.all([
    getMarketSeriesForListing(row.id),
    getDailyBars(row.id, {
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      order: order === "asc" ? "asc" : "desc",
    }),
  ]);
  return NextResponse.json(
    {
      listing: { id: row.id, canonicalKey: row.canonical_key },
      series,
      bars,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
