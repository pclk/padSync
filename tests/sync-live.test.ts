import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/sync/live/route';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';
const sdk = vi.hoisted(() => ({ seal: vi.fn(), create: vi.fn(), raw: vi.fn() }));
vi.mock('@neon/realtime/server', () => ({ createRealtime: sdk.create, rawSql: sdk.raw }));
let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  configureAuthEnv(); db = await freshDb();
  vi.stubEnv('DATABASE_URL', 'postgresql://test:private@db.example/neondb');
  vi.stubEnv('NEON_REALTIME_URL', 'wss://live.example'); vi.stubEnv('NEON_REALTIME_SECRET', 'private-server-secret');
  sdk.create.mockReturnValue({ seal: sdk.seal }); sdk.raw.mockImplementation(sql => sql);
  sdk.seal.mockResolvedValue({ capability: 'sealed-token', queryFingerprint: 'same', expiresAt: Date.now() + 60000 });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await db.pg.close(); });
it('seals only metadata for an authenticated session and never exposes the secret', async () => {
  const response = await POST(req('/api/sync/live', { method: 'POST', session: sessionCookie() }));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const text = await response.text(); expect(text).not.toContain('private');
  expect(JSON.parse(text)).toMatchObject({ enabled: true, login: 'pclk', url: 'wss://live.example' });
  expect(sdk.raw).toHaveBeenCalledWith('SELECT id, seq FROM entities ORDER BY seq DESC LIMIT 1');
  expect(sdk.create).toHaveBeenCalledWith({ secret: 'private-server-secret', db: 'neondb' });
});
it('requires session auth and origin checks, rejecting bridge tokens', async () => {
  for (const [options, status] of [[{},401],[{session:sessionCookie('other')},401],[{session:sessionCookie(),bearer:'x'},403],[{session:sessionCookie(),headers:{origin:'https://evil.example'}},403]] as const) {
    expect((await POST(req('/api/sync/live', { method: 'POST', ...options }))).status).toBe(status);
  }
  expect(sdk.seal).not.toHaveBeenCalled();
});
it('returns a disabled response without configured realtime', async () => {
  vi.stubEnv('NEON_REALTIME_SECRET', '');
  expect(await (await POST(req('/api/sync/live', {method:'POST',session:sessionCookie()}))).json()).toEqual({enabled:false});
  expect(sdk.create).not.toHaveBeenCalled();
});
it('fails gracefully without leaking provider errors', async () => {
  sdk.seal.mockRejectedValueOnce(new Error('private-server-secret'));
  const response=await POST(req('/api/sync/live',{method:'POST',session:sessionCookie()}));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private-server-secret');
});
