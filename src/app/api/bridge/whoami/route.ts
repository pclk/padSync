import type { NextRequest } from "next/server";
import { requireDevice } from "@/server/guard";

/** Lets the bridge check its token without claiming a job. */
export async function GET(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof Response) return auth;
  return Response.json({ device: { id: auth.device.id, name: auth.device.name } }, { headers: { "cache-control": "no-store" } });
}
