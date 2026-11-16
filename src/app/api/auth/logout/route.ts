import type { NextRequest } from "next/server";
import { SESSION_COOKIE, cookie } from "@/server/auth";

export async function POST(req: NextRequest) {
  return new Response(null, { status: 204, headers: { "set-cookie": cookie(SESSION_COOKIE, "", req, 0) } });
}
