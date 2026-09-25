import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import { getEventView } from "../../../../lib/db/read";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { id } = await params;
  // not a uuid → Postgres would throw on the cast; treat as not found
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return NextResponse.json(null, { status: 404 });
  const view = await getEventView(id);
  if (!view) return NextResponse.json(null, { status: 404 });
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
