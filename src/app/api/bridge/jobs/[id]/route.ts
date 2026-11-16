import type { NextRequest } from "next/server";
import { requireDevice } from "@/server/guard";
import { jobUpdateSchema, updateJob } from "@/server/jobs";

// Progress and completion from the bridge. Responds {cancelled: true} when the user cancelled,
// so the bridge can stop the agent.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDevice(req);
  if (auth instanceof Response) return auth;
  const parsed = jobUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const result = await updateJob(auth.sql, (await params).id, auth.device.id, parsed.data);
  if (result.ok) return Response.json({ status: result.status, cancelled: false });
  if (result.reason === "cancelled") return Response.json({ status: "cancelled", cancelled: true });
  return Response.json({ error: "job is not running on this device" }, { status: 409 });
}
