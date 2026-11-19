import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { isPrefKey, readPrefs, writePref } from "@/server/prefs";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// Synced preferences for the signed-in user (src/server/prefs.ts).
export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  return json(await readPrefs(auth.sql, auth.login));
}

/** Body: {key, value}; value null clears the preference. */
export async function PUT(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
  if (!body || typeof body.key !== "string" || !isPrefKey(body.key) || !("value" in body))
    return json({ error: "Send {key, value} for a known preference." }, 400);
  try {
    return json(await writePref(auth.sql, auth.login, body.key, body.value));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
