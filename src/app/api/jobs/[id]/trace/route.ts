import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/guard";
import { addClientTrace, traceSchema } from "@/server/jobs";

// The sending device's own stamps (its response, first words and finished reply on screen), kept with
// the turn so a latency report has them on any device, after a reload, or from another tab.
const bodySchema = z.object({ trace: traceSchema("client") });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  return (await addClientTrace(auth.sql, (await params).id, parsed.data.trace))
    ? Response.json({ ok: true })
    : Response.json({ error: "not found" }, { status: 404 });
}
