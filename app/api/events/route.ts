import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { getRecentEvents } from "../../../lib/db/read";

export async function GET() {
  if (!dbEnabled()) return NextResponse.json([]);
  const events = await getRecentEvents(30);
  return NextResponse.json(events, {
    headers: { "Cache-Control": "no-store" },
  });
}
