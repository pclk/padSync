import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { getJob } from "@/server/jobs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const job = await getJob(auth.sql, (await params).id);
  return job ? Response.json({ job }) : Response.json({ error: "not found" }, { status: 404 });
}
