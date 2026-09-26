import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { getLatestDataDeltas } from "../../../lib/db/read";

export async function GET() {
  if (!dbEnabled()) return NextResponse.json([]);
  const deltas = await getLatestDataDeltas(20);
  return NextResponse.json(deltas, {
    headers: { "Cache-Control": "no-store" },
  });
}
