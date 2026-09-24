import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import { getEventView } from "../../../../lib/db/read";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { id } = await params;
  const view = await getEventView(id);
  if (!view) return NextResponse.json(null, { status: 404 });
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
