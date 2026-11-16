import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Single-user auth: one password (PADSYNC_PASSWORD), exchanged once per device for a
// long-lived httpOnly cookie. Changing the password signs every device out.

export const COOKIE = "padsync_session";

export function authConfigured() {
  return !!process.env.PADSYNC_PASSWORD;
}

export function sessionToken() {
  return createHmac("sha256", process.env.PADSYNC_PASSWORD ?? "").update("padsync-session-v1").digest("hex");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(password: string) {
  return authConfigured() && safeEqual(password, process.env.PADSYNC_PASSWORD!);
}

export function isAuthed(req: NextRequest) {
  if (!authConfigured()) return false;
  const cookie = req.cookies.get(COOKIE)?.value;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = sessionToken();
  return (!!cookie && safeEqual(cookie, token)) || (!!bearer && safeEqual(bearer, token));
}
