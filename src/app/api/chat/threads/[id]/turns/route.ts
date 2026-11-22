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
  const p = chat.newTurnSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: p.error.message }, 400);
  try {
    const turn = await chat.createTurn(auth.sql, (await c.params).id, p.data);
    return turn
      ? json({ turn, serverTime: Date.now() }, 201)
      : json({ error: "Thread not found" }, 404);
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === "ZodError" || e.message === "Invalid attachments")
    )
      return json({ error: e.message }, 400);
    throw e;
  }
}
