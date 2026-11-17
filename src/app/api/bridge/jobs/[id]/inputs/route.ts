import type { NextRequest } from "next/server";
import { requireDevice } from "@/server/guard";
import { getJobInput } from "@/server/jobs";

// The bridge fetches a running job's uploads one part at a time (each fits a response).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDevice(req);
  if (auth instanceof Response) return auth;
  const path = req.nextUrl.searchParams.get("path") ?? "";
  const part = Number(req.nextUrl.searchParams.get("part"));
  if (!path || !Number.isInteger(part) || part < 0) return Response.json({ error: "path and part required" }, { status: 400 });
  const data = await getJobInput(auth.sql, (await params).id, auth.device.id, path, part);
  if (data === null) return Response.json({ error: "no such part, or the job is not running on this device" }, { status: 404 });
  return Response.json({ data }, { headers: { "cache-control": "no-store" } });
}
