import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import * as chat from "@/server/chat";
import { lastBridgeActivity } from "@/server/tokens";
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const q = req.nextUrl.searchParams;
  const [threads, bridgeSeenAt] = await Promise.all([
    chat.listThreads(auth.sql, {
      notebookId: q.get("notebookId") ?? undefined,
      q: q.get("q") ?? "",
      archived: q.get("archived") === "1",
    }),
    lastBridgeActivity(auth.sql),
  ]);
  return json({ threads, bridgeSeenAt });
}
export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  const p = chat.threadSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: p.error.message }, 400);
  return json({ thread: await chat.createThread(auth.sql, p.data) }, 201);
}
