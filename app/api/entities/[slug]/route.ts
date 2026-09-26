import { NextResponse } from "next/server";
import { dbEnabled } from "../../../../lib/db/pool";
import { getEntityEvents } from "../../../../lib/db/read";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!dbEnabled()) return NextResponse.json(null, { status: 404 });
  const { slug } = await params;
  // legacy slugs and canonical keys both route — ':' inside
  // 'company:alphabet'-style keys is part of the identity
  if (!/^[a-z0-9_:]{1,96}$/.test(slug))
    return NextResponse.json(null, { status: 404 });
  const view = await getEntityEvents(slug);
  return NextResponse.json(view, {
    headers: { "Cache-Control": "no-store" },
  });
}
