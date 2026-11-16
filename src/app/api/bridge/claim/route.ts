import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireDevice } from "@/server/guard";
import { AGENTS, claimJob } from "@/server/jobs";

// The bridge polls this. A claim doubles as its heartbeat (device_tokens.last_used_at).
const claimSchema = z.object({
  agents: z.array(z.enum(AGENTS)).min(1).max(AGENTS.length),
  info: z.object({ hostname: z.string().max(100).optional(), version: z.string().max(40).optional() }).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = claimSchema.safeParse(await req.json().catch(() => null));
  const auth = await requireDevice(req, parsed.success ? parsed.data.info : undefined);
  if (auth instanceof Response) return auth;
  if (!parsed.success) return Response.json({ error: "agents: non-empty list of claude|codex" }, { status: 400 });
  const job = await claimJob(auth.sql, auth.device.id, parsed.data.agents);
  return Response.json({ job }, { headers: { "cache-control": "no-store" } });
}
