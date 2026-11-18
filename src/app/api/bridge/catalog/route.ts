import type { NextRequest } from "next/server";
import { requireDevice } from "@/server/guard";
import { catalogSchema, saveCatalog } from "@/server/catalog";

// The bridge sends its logins and models at start-up and whenever they change.
export async function POST(req: NextRequest) {
  const auth = await requireDevice(req);
  if (auth instanceof Response) return auth;
  const parsed = catalogSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  await saveCatalog(auth.sql, auth.device.id, parsed.data.accounts);
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
