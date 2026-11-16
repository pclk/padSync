import { connection, type NextRequest } from "next/server";
import { authConfigured, isAuthed } from "@/server/auth";
import { databaseUrl } from "@/server/db";

export async function GET(req: NextRequest) {
  await connection(); // env and cookies must be read per request, never at build
  const authed = isAuthed(req);
  return Response.json({
    db: !!databaseUrl(),
    auth: authConfigured(),
    authed,
    canvas: { configured: !!process.env.CANVAS_TOKEN, expiresAt: process.env.CANVAS_TOKEN_EXPIRES ?? null },
  });
}
