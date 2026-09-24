import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { getChangesForEntities } from "../../../lib/db/read";
import { parseWatch } from "../../../lib/relevance";

export const maxDuration = 30;

/**
 * Material changes on watched entities — the alert layer.
 * `?e=fed,china` → latest medium/high-materiality changes on events whose
 * entity signature intersects the watch list. Inert without DATABASE_URL.
 */
export async function GET(req: Request) {
  const { entities } = parseWatch(new URL(req.url).searchParams);
  if (!dbEnabled() || entities.length === 0)
    return NextResponse.json({ alerts: [] });
  const alerts = await getChangesForEntities(entities, 40);
  return NextResponse.json(
    { alerts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
