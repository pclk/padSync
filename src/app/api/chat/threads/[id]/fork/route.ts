import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import * as chat from "@/server/chat";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id: string }> };
export async function POST(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const b = await req.json().catch(() => null);
  if (
    !b ||
    !Number.isInteger(b.uptoTurn) ||
    b.uptoTurn < 0 ||
    (b.title !== undefined && typeof b.title !== "string")
  )
    return json({ error: "Invalid fork" }, 400);
  const thread = await chat.forkThread(
    auth.sql,
    (await c.params).id,
    b.uptoTurn,
    b.title,
  );
  return thread
    ? json({ thread }, 201)
    : json({ error: "Thread not found" }, 404);
}
