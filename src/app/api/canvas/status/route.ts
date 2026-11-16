import type { NextRequest } from "next/server";
import { sessionLogin } from "@/server/auth";
import { hasBearerScheme } from "@/server/tokens";

// Verifies the server's Canvas token. Course/file import builds on the same client next.

export async function POST(req: NextRequest) {
  if (hasBearerScheme(req.headers)) return Response.json({ error: "device tokens cannot use this endpoint" }, { status: 403 });
  if (!sessionLogin(req)) return Response.json({ ok: false, error: "Sign in first" }, { status: 401 });
  const token = process.env.CANVAS_TOKEN;
  const base = process.env.CANVAS_BASE_URL ?? "https://canvas.nus.edu.sg";
  if (!token) return Response.json({ ok: false, error: "CANVAS_TOKEN not set" });

  const res = await fetch(`${base}/api/v1/users/self`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  if (!res) return Response.json({ ok: false, error: "Could not reach Canvas" });
  if (res.status === 401) return Response.json({ ok: false, error: "Token rejected: expired or revoked" });
  if (!res.ok) return Response.json({ ok: false, error: `Canvas returned ${res.status}` });
  const me = (await res.json()) as { name?: string };
  return Response.json({ ok: true, name: me.name ?? "unknown" });
}
