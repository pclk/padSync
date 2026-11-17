import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { createJob, listJobs, newJobSchema } from "@/server/jobs";
import { lastBridgeActivity } from "@/server/tokens";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const sectionId = req.nextUrl.searchParams.get("sectionId") ?? undefined;
  const notebookId = req.nextUrl.searchParams.get("notebookId") ?? undefined;
  const kind = req.nextUrl.searchParams.get("kind") === "import" ? "import" : undefined;
  if (!sectionId && !notebookId && !kind) return Response.json({ error: "sectionId, notebookId or kind=import required" }, { status: 400 });
  const [jobs, bridgeSeenAt] = await Promise.all([listJobs(auth.sql, { sectionId, notebookId, kind }), lastBridgeActivity(auth.sql)]);
  return Response.json({ jobs, bridgeSeenAt });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const parsed = newJobSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  return Response.json({ job: await createJob(auth.sql, parsed.data) }, { status: 201 });
}
