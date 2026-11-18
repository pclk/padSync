import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { loadCatalog } from "@/server/catalog";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  return Response.json(await loadCatalog(auth.sql), { headers: { "Cache-Control": "no-store" } });
}
