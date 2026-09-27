import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../../lib/db/pool";
import {
  getDailyBarsForSeries,
  getMarketSeries,
} from "../../../../../lib/db/read";
import { isCalendarDate } from "../../../../../lib/market";

/* Read-only bars for ONE market series — the canonical primitive.
 *   /api/market/series/<series uuid|series:canonical_key>
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=1..5000&order=asc|desc
 * Series identity (provider/dataset/interval/session/basis) is always
 * exposed beside the bars. */
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { id } = await params;
  let key: string;
  try {
    key = decodeURIComponent(id);
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
  // series uuid or series:canonical_key — bound the shape before querying
  if (!/^[0-9a-f-]{36}$|^series:[a-z0-9_:.-]{1,200}$/i.test(key))
    return NextResponse.json(null, { status: 404 });
  const series = await getMarketSeries(key);
  if (!series) return NextResponse.json(null, { status: 404 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
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

  const bars = await getDailyBarsForSeries(series.id, {
    from: from ?? undefined,
    to: to ?? undefined,
    limit,
    order,
  });
  return NextResponse.json(
    { series, bars },
    { headers: { "Cache-Control": "no-store" } },
  );
}
