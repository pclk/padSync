import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { cancelJob } from "@/server/jobs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const job = await cancelJob(auth.sql, (await params).id);
  return job ? Response.json({ job }) : Response.json({ error: "job is not queued or running" }, { status: 409 });
}
