import type { NextRequest } from "next/server";
import { requireDevice } from "@/server/guard";
import { sealLive } from "@/server/live";

// A live query on queued jobs, so the bridge claims a new one at once instead of at its next poll.
export async function POST(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof Response) return auth;
  try {
    return Response.json(await sealLive("select id from jobs where status = 'queued'"), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Realtime unavailable; polling continues." }, { status: 503 });
  }
}
