import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import {
  getMacroPointHistory,
  getMacroPoints,
  getMacroSeriesList,
} from "../../../../lib/db/read";

/* Canonical macro-indicator reads:
 *   /api/macro                                → series list + latest values
 *   /api/macro/macro_series:fred:CPIAUCSL     → points (latest vintage)
 *     ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N&order=asc|desc
 *     &asOf=YYYY-MM-DD   → ALFRED view: values official at that vintage
 *     &history=YYYY-MM-DD → full revision trail for one obs_date
 * Series identity is canonical_key — never a bare display title. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key?: string[] }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { key } = await params;
  const url = new URL(req.url);
  if (!key || key.length === 0) {
    return NextResponse.json(await getMacroSeriesList(), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  // segments may arrive percent-encoded — decode before validating
  let canonicalKey = key.join(":");
  try {
    canonicalKey = decodeURIComponent(canonicalKey);
  } catch {
    /* malformed escape — regex rejects it below */
  }
  if (!/^macro_series:[a-z0-9_:.\-]{1,120}$/i.test(canonicalKey))
    return NextResponse.json(null, { status: 404 });
  const history = url.searchParams.get("history");
  const view = history
    ? await getMacroPointHistory(canonicalKey, history)
    : await getMacroPoints(canonicalKey, {
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        limit: url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined,
        order: url.searchParams.get("order") === "desc" ? "desc" : "asc",
        asOf: url.searchParams.get("asOf") ?? undefined,
      });
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
