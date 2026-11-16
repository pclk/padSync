import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { revokeDeviceToken } from "@/server/tokens";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const revoked = await revokeDeviceToken(auth.sql, id);
  return revoked ? new Response(null, { status: 204 }) : Response.json({ error: "not found or already revoked" }, { status: 404 });
}
