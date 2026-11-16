import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/guard";
import { createDeviceToken, listDeviceTokens } from "@/server/tokens";

const createSchema = z.object({ name: z.string().trim().min(1).max(60) });

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  return Response.json({ tokens: await listDeviceTokens(auth.sql) });
}

/** Creates a device token. The plaintext is in this response only; it is never stored. */
export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "name is required (1–60 chars)" }, { status: 400 });
  const { token, record } = await createDeviceToken(auth.sql, parsed.data.name, auth.login);
  return Response.json({ token, record }, { status: 201, headers: { "cache-control": "no-store" } });
}
