import "server-only";
import { z } from "zod";
import type { Sql } from "./db";
import { AGENTS, jobOptionsSchema } from "./jobs";
import { DEVICE_SETTING_KEYS } from "@/lib/device-setting-keys";

/** Each setting's stored JSON and when it changed; the prompts are the largest, a few KB. */
const deviceSettings = z
  .partialRecord(z.enum(DEVICE_SETTING_KEYS), z.object({ v: z.string().max(100_000), at: z.number().nonnegative() }).strict())
  .nullable();

// Preferences that follow the signed-in user to every device, unlike src/lib/settings.ts, which
// stay in one browser. Each key has its own schema; unknown keys are refused.

export const PREF_SCHEMAS = {
  /** The model new chats start on: agent, model, effort and login (src/lib/chat-ui.ts defaultSettings). */
  "chat.defaultModel": z
    .object({
      agent: z.enum(AGENTS),
      options: jobOptionsSchema.pick({ model: true, effort: true, account: true }).strict(),
    })
    .strict()
    .nullable(),
  /** One kind of device's own settings (src/lib/device-settings.ts), kept apart per kind. */
  "device.ipad": deviceSettings,
  "device.desktop": deviceSettings,
} as const;
export type PrefKey = keyof typeof PREF_SCHEMAS;
export const isPrefKey = (k: string): k is PrefKey => Object.hasOwn(PREF_SCHEMAS, k);

export async function readPrefs(sql: Sql, login: string) {
  const rows = await sql.query<{ key: string; value: unknown; updated_at: string | Date }>(
    `select key, value, updated_at from user_prefs where login = $1`,
    [login.toLowerCase()],
  );
  const prefs: Record<string, unknown> = {};
  const updatedAt: Record<string, string> = {};
  for (const r of rows) {
    if (!isPrefKey(r.key)) continue;
    const parsed = PREF_SCHEMAS[r.key].safeParse(r.value);
    if (!parsed.success) continue;
    prefs[r.key] = parsed.data;
    updatedAt[r.key] = new Date(r.updated_at).toISOString();
  }
  return { prefs, updatedAt };
}

/** Stores one preference; `null` clears it. */
export async function writePref(sql: Sql, login: string, key: PrefKey, value: unknown) {
  const v = PREF_SCHEMAS[key].parse(value);
  if (v === null) await sql.query(`delete from user_prefs where login = $1 and key = $2`, [login.toLowerCase(), key]);
  else
    await sql.query(
      `insert into user_prefs(login, key, value) values($1, $2, $3::jsonb)
       on conflict (login, key) do update set value = excluded.value, updated_at = now()`,
      [login.toLowerCase(), key, JSON.stringify(v)],
    );
  return readPrefs(sql, login);
}
