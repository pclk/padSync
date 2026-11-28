import { chatJobContext } from '@/server/chat';
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createLivePass } from "@/server/auth";
import { requireDevice } from "@/server/guard";
import { AGENTS, BRIDGE_FEATURES, claimJob } from "@/server/jobs";

// The bridge polls this. A claim doubles as its heartbeat (device_tokens.last_used_at).
const claimSchema = z.object({
  agents: z.array(z.enum(AGENTS)).min(1).max(AGENTS.length),
  info: z.object({ hostname: z.string().max(100).optional(), version: z.string().max(40).optional() }).optional(),
  /** Job kinds this bridge understands besides questions (unknown ones are ignored). */
  features: z.array(z.string().max(40)).max(20).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = claimSchema.safeParse(await req.json().catch(() => null));
  const auth = await requireDevice(req, parsed.success ? parsed.data.info : undefined);
  if (auth instanceof Response) return auth;
  if (!parsed.success) return Response.json({ error: "agents: non-empty list of claude|codex" }, { status: 400 });
  const features = (parsed.data.features ?? []).filter((f): f is (typeof BRIDGE_FEATURES)[number] => (BRIDGE_FEATURES as readonly string[]).includes(f));
  const job = await claimJob(auth.sql, auth.device.id, parsed.data.agents, features);
  const body = { job: job ? { ...job, ...(job.kind === 'chat' ? await chatJobContext(auth.sql, job.id) : {}) } : null };
  // serverTime lets the bridge line its clock up with ours for latency traces; livePass lets it
  // renew its realtime query without a database round trip (src/app/api/bridge/live/route.ts).
  return Response.json({ ...body, serverTime: Date.now(), livePass: createLivePass(auth.device.id) }, { headers: { "cache-control": "no-store" } });
}
