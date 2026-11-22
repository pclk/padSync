import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import * as chat from "@/server/chat";
import { sealLive } from "@/server/live";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id: string }> };
// A live query on the thread's turns: any change (a new turn, new text, a finished reply) tells the
// open chat to fetch now instead of at its next poll.
export async function POST(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const { id } = await c.params;
  if (!(await chat.getThread(auth.sql, id))) return json({ error: "Thread not found" }, 404);
  try {
    return json(await sealLive("select id, status, updated_at from jobs where thread_id = $1", [id]));
  } catch {
    return json({ error: "Realtime unavailable; polling continues." }, 503);
  }
}
