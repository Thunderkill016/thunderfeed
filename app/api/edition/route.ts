import { NextResponse } from "next/server";
import { getEdition } from "../../../lib/edition";

export const maxDuration = 60;

export async function GET() {
  const edition = await getEdition();
  // never served yet — signal the client to keep its current edition
  // instead of wiping the page to the empty degrade payload
  if (!edition.updatedAt)
    return NextResponse.json(
      { error: "edition unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  return NextResponse.json(edition, {
    headers: { "Cache-Control": "no-store" },
  });
}
