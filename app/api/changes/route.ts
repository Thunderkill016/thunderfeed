import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { getLatestChanges } from "../../../lib/db/read";

export async function GET() {
  if (!dbEnabled()) return NextResponse.json([]);
  const changes = await getLatestChanges(30);
  return NextResponse.json(changes, {
    headers: { "Cache-Control": "no-store" },
  });
}
