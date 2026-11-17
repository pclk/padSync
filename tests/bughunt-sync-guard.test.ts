import { beforeEach, expect, it, vi } from 'vitest';
import { configureAuthEnv, req, sessionCookie } from './helpers/env';
const getSql = vi.hoisted(() => vi.fn());
vi.mock('@/server/db', () => ({ getSql }));
import { requireSession } from '@/server/guard';

beforeEach(() => { configureAuthEnv(); getSql.mockReset(); getSql.mockRejectedValue(new Error('database unavailable')); });
it('rejects unsigned requests without bootstrapping Neon', async () => {
  const response = await requireSession(req('/api/sync', { body: {} }));
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(401);
  expect(getSql).not.toHaveBeenCalled();
});
it('rejects bearer and cross-origin requests without bootstrapping Neon', async () => {
  for (const options of [{ bearer: 'psd_invalid' }, { headers: { origin: 'https://other.test' } }]) {
    const response = await requireSession(req('/api/sync', { body: {}, session: sessionCookie(), ...options }));
    expect((response as Response).status).toBe(403);
  }
  expect(getSql).not.toHaveBeenCalled();
});
it('initializes the database once for an admitted session', async () => {
  const sql = { query: vi.fn() }; getSql.mockResolvedValue(sql);
  expect(await requireSession(req('/api/sync', { body: {}, session: sessionCookie() }))).toEqual({ sql, login: 'pclk' });
  expect(getSql).toHaveBeenCalledTimes(1);
});
