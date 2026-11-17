import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { jobInputSchema, putJobInput } from "@/server/jobs";

// One base64 part of a declared upload (AI import lecture files). The last part queues the job.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const parsed = jobInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  const r = await putJobInput(auth.sql, (await params).id, parsed.data);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ status: r.status, received: r.received, expected: r.expected });
}
