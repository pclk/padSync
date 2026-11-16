import "server-only";
import type { NextRequest } from "next/server";
import { sessionLogin } from "./auth";
import { getSql, type Sql } from "./db";
import { bearerToken, verifyDeviceToken, type DeviceToken } from "./tokens";

// Two kinds of caller, never interchangeable:
// - session: the GitHub-signed-in browser (iPad/Mac). Can do everything except bridge calls.
// - device: a bearer device token (the Mac bridge). Can only use /api/bridge/*.

const json = (status: number, error: string) => Response.json({ error }, { status });

export async function requireSession(req: NextRequest): Promise<{ sql: Sql; login: string } | Response> {
  const sql = await getSql();
  if (!sql) return json(503, "database not configured");
  if (bearerToken(req.headers)) return json(403, "device tokens cannot use this endpoint");
  const login = sessionLogin(req);
  if (!login) return json(401, "unauthorized");
  return { sql, login };
}

export async function requireDevice(req: NextRequest, seenInfo?: Record<string, unknown>): Promise<{ sql: Sql; device: DeviceToken } | Response> {
  const sql = await getSql();
  if (!sql) return json(503, "database not configured");
  const device = await verifyDeviceToken(sql, bearerToken(req.headers), seenInfo);
  if (!device) return json(401, "invalid or revoked device token");
  return { sql, device };
}
