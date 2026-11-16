import type { NextRequest } from "next/server";
import { COOKIE, authConfigured, checkPassword, sessionToken } from "@/server/auth";

export async function POST(req: NextRequest) {
  if (!authConfigured()) return Response.json({ error: "PADSYNC_PASSWORD not set" }, { status: 503 });
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !checkPassword(password)) return Response.json({ error: "wrong password" }, { status: 401 });

  const res = Response.json({ ok: true });
  const secure = req.nextUrl.protocol === "https:" ? "; Secure" : "";
  res.headers.append("set-cookie", `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  return res;
}
