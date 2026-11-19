import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import * as chat from "@/server/chat";
import { lastBridgeActivity } from "@/server/tokens";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const { id } = await c.params;
  const thread = await chat.getThread(auth.sql, id);
  if (!thread) return json({ error: "Thread not found" }, 404);
  const q = req.nextUrl.searchParams;
  const since = q.get("since") ?? undefined;
  if (since && !Number.isFinite(Date.parse(since)))
    return json({ error: "Invalid since" }, 400);
  const now = new Date().toISOString();
  const [turns, bridgeSeenAt] = await Promise.all([
    chat.getTurns(auth.sql, id, since, q.get("from") ?? ""),
    lastBridgeActivity(auth.sql),
  ]);
  // serverTime: as late as possible, so the device can estimate its clock offset (chat-trace.ts).
  return json({ thread, turns, bridgeSeenAt, now, serverTime: Date.now() });
}
export async function PATCH(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const { id } = await c.params;
  const p = chat.patchSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: p.error.message }, 400);
  const thread = await chat.patchThread(auth.sql, id, p.data);
  return thread ? json({ thread }) : json({ error: "Thread not found" }, 404);
}
export async function DELETE(req: NextRequest, c: Context) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  await chat.deleteThread(auth.sql, (await c.params).id);
  return json({ ok: true });
}
