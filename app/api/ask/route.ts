import { NextResponse } from "next/server";
import { dbEnabled } from "../../../lib/db/pool";
import { answerQuestion } from "../../../lib/ask";

export const maxDuration = 30;

export async function GET(req: Request) {
  if (!dbEnabled())
    return NextResponse.json({ error: "db off" }, { status: 503 });
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 3 || q.length > 500)
    return NextResponse.json({ error: "bad query" }, { status: 400 });
  const result = await answerQuestion(q);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
