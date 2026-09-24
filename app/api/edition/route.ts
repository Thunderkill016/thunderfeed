import { NextResponse } from "next/server";
import { getEdition } from "../../../lib/edition";

export const maxDuration = 60;

export async function GET() {
  const edition = await getEdition();
  return NextResponse.json(edition, {
    headers: { "Cache-Control": "no-store" },
  });
}
