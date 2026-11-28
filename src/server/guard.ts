import "server-only";
import type { NextRequest } from "next/server";
import { sessionLogin } from "./auth";
import { getSql, type Sql } from "./db";
import { bearerToken, hasBearerScheme, verifyDeviceToken, type DeviceToken } from "./tokens";

// Two kinds of caller, never interchangeable:
// - session: the GitHub-signed-in browser (iPad/Mac). Can do everything except bridge calls.
// - device: a bearer device token (the Mac bridge). Can only use /api/bridge/*.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const json = (status: number, error: string) => Response.json({ error }, { status });

/** The session checks alone, without touching the database: for routes that must not wake it. */
export function requireLogin(req: NextRequest): { login: string } | Response {
  if (hasBearerScheme(req.headers)) return json(403, "device tokens cannot use this endpoint");
  // CSRF: the session cookie is SameSite=Lax; also refuse state changes from another origin.
  const origin = req.headers.get("origin");
  if (!SAFE_METHODS.has(req.method) && origin && origin !== req.nextUrl.origin) return json(403, "cross-origin request refused");
  const login = sessionLogin(req);
  if (!login) return json(401, "unauthorized");
  return { login };
}

export async function requireSession(req: NextRequest): Promise<{ sql: Sql; login: string } | Response> {
  const auth = requireLogin(req);
  if (auth instanceof Response) return auth;
  const { login } = auth;
  const sql = await getSql();
  if (!sql) return json(503, "database not configured");
  return { sql, login };
}

export async function requireDevice(req: NextRequest, seenInfo?: Record<string, unknown>): Promise<{ sql: Sql; device: DeviceToken } | Response> {
  const sql = await getSql();
  if (!sql) return json(503, "database not configured");
  const device = await verifyDeviceToken(sql, bearerToken(req.headers), seenInfo);
  if (!device) return json(401, "invalid or revoked device token");
  return { sql, device };
}
