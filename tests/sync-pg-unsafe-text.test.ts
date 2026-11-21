import { afterEach, expect, it } from 'vitest';
import { POST } from '@/app/api/sync/route';
import { setSqlForTests } from '@/server/db';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';

afterEach(() => setSqlForTests(null));

// PDF text layers can carry NUL and unpaired surrogates; jsonb rejects both and the push used to 500.
it('stores text Postgres jsonb would reject instead of failing the push', async () => {
  configureAuthEnv();
  const { sql, pg } = await freshDb();
  try {
    setSqlForTests(sql);
    const page = { text: 'a\u0000b\ud83dc', ['k\u0000']: ['\udc00'] };
    const res = await POST(req('/api/sync', { session: sessionCookie(), body: {
      since: 0,
      changes: [{ id: 's1', kind: 'section', notebookId: 'nb', parentId: '', data: { pages: [page] }, hlc: '0000000000001-0000-device', deleted: 0 }],
      events: [{ id: 'e1', notebookId: 'nb', sectionId: null, type: 'pdf', t: 1, device: 'd', data: { name: 'x\u0000.pdf' } }],
    } }));
    expect(res.status).toBe(200);
    const [row] = await sql.query<{ data: { pages: Record<string, unknown>[] } }>(`select data from entities where id = 's1'`);
    expect(row.data.pages[0]).toEqual({ text: 'ab�c', k: ['�'] });
    const [ev] = await sql.query<{ data: { name: string } }>(`select data from events where id = 'e1'`);
    expect(ev.data.name).toBe('x.pdf');
  } finally { await pg.close(); }
});
