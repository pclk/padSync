import { connection, type NextRequest } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE, STATE_COOKIE, allowedLogin, authConfigured, cookie, createSession, safeNext } from "@/server/auth";

// Step 2: GitHub redirects back with ?code&state. Check state, swap the code for a token, read
// the user, and only issue a session to the allowed login. The GitHub token is discarded.
export async function GET(req: NextRequest) {
  await connection();
  if (!authConfigured()) return new Response("GitHub sign-in is not configured on the server.", { status: 503 });

  const fail = (reason: string) => redirect(req, `/settings?auth_error=${encodeURIComponent(reason)}`, cookie(STATE_COOKIE, "", req, 0));

  let saved: { state?: string; next?: string } = {};
  try {
    saved = JSON.parse(Buffer.from(req.cookies.get(STATE_COOKIE)?.value ?? "", "base64url").toString() || "{}");
  } catch {}
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state || !saved.state || state !== saved.state) return fail("Sign-in expired, try again");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${req.nextUrl.origin}/api/auth/github/callback`,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!token.access_token) return fail(token.error_description ?? "GitHub did not return a token");

  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "padSync" },
  });
  const user = (await userRes.json().catch(() => ({}))) as { login?: string };
  if (!user.login) return fail("Could not read your GitHub account");
  if (user.login.toLowerCase() !== allowedLogin()) return fail(`@${user.login} is not allowed to use this padSync`);

  return redirect(req, safeNext(saved.next ?? null), cookie(STATE_COOKIE, "", req, 0), cookie(SESSION_COOKIE, createSession(user.login), req, SESSION_MAX_AGE));
}

function redirect(req: NextRequest, path: string, ...cookies: string[]) {
  const headers = new Headers({ location: new URL(path, req.nextUrl.origin).toString() });
  cookies.forEach((c) => headers.append("set-cookie", c));
  return new Response(null, { status: 302, headers });
}
