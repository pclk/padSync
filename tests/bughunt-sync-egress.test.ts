import { afterEach, expect, it } from 'vitest';
import { POST } from '@/app/api/sync/route';
import { setSqlForTests, type Sql } from '@/server/db';
import { configureAuthEnv, freshDb, req, sessionCookie } from './helpers/env';

afterEach(() => setSqlForTests(null));

it('avoids downloading accepted payloads twice while retaining conflict winners and cursor progress', async () => {
  configureAuthEnv();
  const { sql, pg } = await freshDb();
  try {
    let bytes = 0;
    let queries = 0;
    const resultBytes: number[] = [];
    const counting: Sql = { query: async (text, params) => {
      const rows = await sql.query(text, params);
      // Ignore the test adapter's schema initialization.
      if (/^\s*(select|with locked|insert into events)/i.test(text) && !/schema_state/.test(text)) {
        queries++;
        const size = Buffer.byteLength(JSON.stringify(rows));
        bytes += size;
        resultBytes.push(size);
      }
      return rows as never;
    } };
    setSqlForTests(counting);
    const entity = { id: 'large', kind: 'section', notebookId: 'nb', parentId: '', data: { text: 'x'.repeat(100_000) }, hlc: '0000000000002-0000-device', deleted: 0 };
    const call = async (changes: unknown[], since = 0) =>
      (await POST(req('/api/sync', { session: sessionCookie(), body: { changes, since, events: [] } }))).json();
    const first = await call([entity]);
    expect(first.changes).toEqual([]);
    expect(first.cursor).toBeGreaterThan(0);
    expect(queries).toBe(3);
    expect(bytes).toBeLessThan(500);
    expect(resultBytes[1]).toBe(2); // conflict readback: 100 KB -> empty array
    expect(resultBytes[2]).toBeLessThan(500); // pull: 100 KB -> metadata only
    // Before: both readback and pull returned the 100 KB JSON.
    const baseline = await sql.query('select id, kind, notebook_id, parent_id, data, hlc, deleted, seq from entities');
    expect(Buffer.byteLength(JSON.stringify(baseline)) * 2).toBeGreaterThan(200_000);
    bytes = 0; queries = 0;
    const conflict = await call([{ ...entity, hlc: '0000000000001-0000-device', data: {} }], first.cursor);
    expect(conflict.changes).toEqual([entity]);
    expect(bytes).toBeGreaterThan(100_000);
    expect(queries).toBe(3);
    bytes = 0; queries = 0;
    const idle = await call([], first.cursor);
    expect(idle.changes).toEqual([]);
    expect(queries).toBe(1);
    expect(bytes).toBe(2);
  } finally { await pg.close(); }
});
