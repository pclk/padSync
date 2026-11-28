import type { NextRequest } from "next/server";
import { LIVE_PASS_HEADER, createLivePass, livePassDevice } from "@/server/auth";
import { requireDevice } from "@/server/guard";
import { sealLive } from "@/server/live";

// A live query on queued jobs, so the bridge claims a new one at once instead of at its next poll.
// Renewals come with a live pass (from the last claim) and skip the database, so an idle bridge
// lets Neon scale to zero; without one, the device token is checked as usual.
export async function POST(req: NextRequest) {
  let device = livePassDevice(req.headers.get(LIVE_PASS_HEADER));
  if (!device) {
    const auth = await requireDevice(req);
    if (auth instanceof Response) return auth;
    device = auth.device.id;
  }
  try {
    const live = await sealLive("select id from jobs where status = 'queued'");
    return Response.json({ ...live, livePass: createLivePass(device) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Realtime unavailable; polling continues." }, { status: 503 });
  }
}
