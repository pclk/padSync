import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import * as chat from "@/server/chat";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id: string; turn: string }> };
export async function POST(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const p = await c.params;
  const turn = await chat.regenerate(auth.sql, p.id, Number(p.turn));
  return turn
    ? json({ turn }, 201)
    : json({ error: "Only the last turn can be regenerated" }, 409);
}
