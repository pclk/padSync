import type { NextRequest } from 'next/server';
import { requireSession } from '@/server/guard';
import { isAdminLogin, readSyncConfig } from '@/server/sync-config';
import { DEFAULT_SYNC_CONFIG, SYNC_FIELDS, validSyncField, type SyncConfig } from '@/lib/sync-policy';
export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  return Response.json({ ...(await readSyncConfig(auth.sql)), admin: isAdminLogin(auth.login) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function PUT(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  if (!isAdminLogin(auth.login)) return Response.json({ error: 'Admin required' }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !(key in SYNC_FIELDS) || !Object.hasOwn(SYNC_FIELDS, key) || !validSyncField(key as keyof SyncConfig, body[key]))) {
    return Response.json({ error: 'Provide valid integer milliseconds for sync timing fields.' }, { status: 400 });
  }
  // Partial updates keep older clients from overwriting the new controls.
  await auth.sql.query(`insert into sync_config(id,debounce_ms,visible_poll_ms,hidden_poll_ms,retry_base_ms)
    values(1,coalesce($1::integer,$5::integer),coalesce($2::integer,$6::integer),coalesce($3::integer,$7::integer),coalesce($4::integer,$8::integer))
    on conflict(id) do update set debounce_ms=coalesce($1,sync_config.debounce_ms),
    visible_poll_ms=coalesce($2,sync_config.visible_poll_ms), hidden_poll_ms=coalesce($3,sync_config.hidden_poll_ms),
    retry_base_ms=coalesce($4,sync_config.retry_base_ms)`,
    [body.debounceMs ?? null, body.visiblePollMs ?? null, body.hiddenPollMs ?? null, body.retryBaseMs ?? null,
      DEFAULT_SYNC_CONFIG.debounceMs, DEFAULT_SYNC_CONFIG.visiblePollMs, DEFAULT_SYNC_CONFIG.hiddenPollMs, DEFAULT_SYNC_CONFIG.retryBaseMs]);
  return Response.json(await readSyncConfig(auth.sql));
}
