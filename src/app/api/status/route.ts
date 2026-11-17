import { connection, type NextRequest } from "next/server";
import { allowedLogin, authConfigured, sessionLogin } from "@/server/auth";
import { databaseUrl, getSql } from "@/server/db";
import { isAdminLogin } from "@/server/sync-config";
import { lastBridgeActivity } from "@/server/tokens";

export async function GET(req: NextRequest) {
  await connection(); // env and cookies must be read per request, never at build
  const login = sessionLogin(req);
  // Bridge liveness is only shown to the signed-in user.
  const sql = login ? await getSql().catch(() => null) : null;
  const bridgeSeenAt = sql ? await lastBridgeActivity(sql).catch(() => null) : null;
  return Response.json({
    db: !!databaseUrl(),
    auth: authConfigured(),
    authed: login !== null,
    login,
    admin: isAdminLogin(login),
    allowed: allowedLogin(),
    bridgeSeenAt,
    canvas: { configured: !!process.env.CANVAS_TOKEN, expiresAt: process.env.CANVAS_TOKEN_EXPIRES ?? null },
  });
}
