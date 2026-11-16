import { connection, type NextRequest } from "next/server";
import { STATE_COOKIE, authConfigured, cookie, newState, safeNext } from "@/server/auth";

// Step 1: send the browser to GitHub with a one-time state bound to this browser by cookie.
export async function GET(req: NextRequest) {
  await connection();
  if (!authConfigured()) return new Response("GitHub sign-in is not configured on the server.", { status: 503 });

  const state = newState();
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${req.nextUrl.origin}/api/auth/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("allow_signup", "false");

  const value = Buffer.from(JSON.stringify({ state, next })).toString("base64url");
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie(STATE_COOKIE, value, req, 600) } });
}
