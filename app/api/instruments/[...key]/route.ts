import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import {
  getCorporateActionsForInstrument,
  getInstrumentView,
} from "../../../../lib/db/read";

/* Canonical instrument lookup: /api/instruments/instrument:alphabet:class_a_common_stock
 * Read-only master-data view — issuer, identifiers, listings, provenance.
 * No prices, no recommendations.
 *
 * /api/instruments/<instrument-key>/corporate-actions returns canonical
 * actions + current versions + provider assertions + derivations +
 * agreement state. Instrument canonical_key is the identity — never a
 * bare ticker. Raw provider payloads stay out (assertions carry their
 * observation ids; the payload itself is not exposed). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { key } = await params;
  const segs = [...key];
  const sub =
    segs.length > 1 && segs[segs.length - 1] === "corporate-actions"
      ? (segs.pop(), "corporate-actions")
      : null;
  const canonicalKey = segs.join(":");
  if (!/^instrument:[a-z0-9_:]{1,120}$/.test(canonicalKey))
    return NextResponse.json(null, { status: 404 });
  const view = sub
    ? await getCorporateActionsForInstrument(canonicalKey)
    : await getInstrumentView(canonicalKey);
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
