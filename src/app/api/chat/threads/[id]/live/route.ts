import type { NextRequest } from "next/server";
import { requireLogin } from "@/server/guard";
import { sealLive } from "@/server/live";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id: string }> };
// A live query on the thread's turns: any change (a new turn, new text, a finished reply) tells the
// open chat to fetch now instead of at its next poll. Renewed every minute while a chat is open, so
// it skips the database (no thread lookup): the sealed rows are only ids, statuses and times, and an
// unknown id just matches nothing.
export async function POST(req: NextRequest, c: Context) {
  const auth = requireLogin(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const { id } = await c.params;
  try {
    return json(await sealLive("select id, status, updated_at from jobs where thread_id = $1", [id]));
  } catch {
    return json({ error: "Realtime unavailable; polling continues." }, 503);
  }
}
