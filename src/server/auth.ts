import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// GitHub OAuth, single user. Only ALLOWED_GITHUB_LOGIN (default "pclk") may sign in. The session
// is a signed cookie: base64url({login, exp}).hmac, keyed by SESSION_SECRET. Rotating the
// secret signs every device out.

export const SESSION_COOKIE = "padsync_session";
export const STATE_COOKIE = "padsync_oauth_state";
const SESSION_DAYS = 365;

export function allowedLogin() {
  return (process.env.ALLOWED_GITHUB_LOGIN ?? "pclk").toLowerCase();
}

export function authConfigured() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.SESSION_SECRET);
}

function sign(payload: string) {
  return createHmac("sha256", process.env.SESSION_SECRET ?? "").update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createSession(login: string) {
  const payload = Buffer.from(JSON.stringify({ login, exp: Date.now() + SESSION_DAYS * 86_400_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

// A live pass lets the bridge renew its realtime query without a database lookup of its token,
// which would wake a suspended Neon compute every minute. It only unlocks a sealed list of queued
// job ids (src/server/live.ts), so a pass outliving a revoked token for a few hours is harmless.
const LIVE_PASS_MS = 6 * 3_600_000;
/** Sent by the bridge with its live renewals (bridge/lib.ts BridgeApi.live). */
export const LIVE_PASS_HEADER = "x-padsync-live-pass";

export function createLivePass(deviceId: string) {
  const payload = Buffer.from(JSON.stringify({ live: deviceId, exp: Date.now() + LIVE_PASS_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The device a live pass was issued to, or null when it is missing, forged or expired. */
export function livePassDevice(pass: string | null): string | null {
  if (!pass || !process.env.SESSION_SECRET) return null;
  const [payload, sig] = pass.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { live, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { live?: unknown; exp?: unknown };
    return typeof live === "string" && typeof exp === "number" && exp > Date.now() ? live : null;
  } catch {
    return null;
  }
}

export function sessionLogin(req: NextRequest): string | null {
  if (!authConfigured()) return null;
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { login, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { login: string; exp: number };
    return exp > Date.now() && login.toLowerCase() === allowedLogin() ? login : null;
  } catch {
    return null;
  }
}

export function newState() {
  return randomBytes(16).toString("base64url");
}

export function cookie(name: string, value: string, req: NextRequest, maxAgeSec: number) {
  const secure = req.nextUrl.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86_400;

/** Only same-site relative paths, so the login flow can't be turned into an open redirect. */
export function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
