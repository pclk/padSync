import { connection, type NextRequest } from "next/server";
import { allowedLogin, authConfigured, sessionLogin } from "@/server/auth";
import { databaseUrl } from "@/server/db";

export async function GET(req: NextRequest) {
  await connection(); // env and cookies must be read per request, never at build
  const login = sessionLogin(req);
  return Response.json({
    db: !!databaseUrl(),
    auth: authConfigured(),
    authed: login !== null,
    login,
    allowed: allowedLogin(),
    canvas: { configured: !!process.env.CANVAS_TOKEN, expiresAt: process.env.CANVAS_TOKEN_EXPIRES ?? null },
  });
}
