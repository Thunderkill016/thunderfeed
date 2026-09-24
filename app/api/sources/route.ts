import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { getSourceReliability } from "../../../lib/db/read";

export const maxDuration = 30;

export async function GET() {
  if (!dbEnabled())
    return NextResponse.json({ error: "db off" }, { status: 503 });
  const sources = await getSourceReliability();
  return NextResponse.json(
    { sources },
    { headers: { "Cache-Control": "no-store" } },
  );
}
