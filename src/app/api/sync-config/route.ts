import type { NextRequest } from 'next/server';
import { requireSession } from '@/server/guard';
import { isAdminLogin, readSyncConfig } from '@/server/sync-config';
import { validDebounce } from '@/lib/sync-policy';
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
  if (!body || Object.keys(body).length !== 1 || !validDebounce(body.debounceMs)) return Response.json({ error: 'debounceMs must be an integer from 100 to 10000' }, { status: 400 });
  await auth.sql.query('insert into sync_config(id,debounce_ms) values(1,$1) on conflict(id) do update set debounce_ms=excluded.debounce_ms', [body.debounceMs]);
  return Response.json({ debounceMs: body.debounceMs });
}
