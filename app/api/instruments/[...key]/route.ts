import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import { getInstrumentView } from "../../../../lib/db/read";

/* Canonical instrument lookup: /api/instruments/instrument:alphabet:class_a_common_stock
 * Read-only master-data view — issuer, identifiers, listings, provenance.
 * No prices, no recommendations. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { key } = await params;
  const canonicalKey = key.join(":");
  if (!/^instrument:[a-z0-9_:]{1,120}$/.test(canonicalKey))
    return NextResponse.json(null, { status: 404 });
  const view = await getInstrumentView(canonicalKey);
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
