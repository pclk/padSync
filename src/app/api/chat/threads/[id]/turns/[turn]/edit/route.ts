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
  const body = await req.json().catch(() => null);
  const parsed = chat.newTurnSchema.pick({ question: true }).safeParse(body);
  if (!parsed.success)
    return json(
      { error: "Enter a question between 1 and 4000 characters." },
      400,
    );
  try {
    const thread = await chat.editTurn(
      auth.sql,
      p.id,
      Number(p.turn),
      parsed.data.question,
    );
    return thread
      ? json({ thread }, 201)
      : json({ error: "Turn not found" }, 404);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Original inputs"))
      return json({ error: e.message }, 409);
    throw e;
  }
}
