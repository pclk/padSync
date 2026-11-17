import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { POST } from '@/app/api/sync/route';
import { migrate, setSqlForTests } from '@/server/db';
import { configureAuthEnv, req, sessionCookie } from './helpers/env';

// Optional real PostgreSQL checks: PGlite serializes queries and cannot exercise lock waits.
// Only a local disposable server is accepted. Every test uses an isolated schema.
const connectionString = process.env.PADSYNC_TEST_POSTGRES_URL;
const suite = connectionString ? it : it.skip;
let pool: Pool;
let admin: Pool;
const schema = `padsync_test_${process.pid}_${Date.now()}`;
const application = `${schema}_writer`;
const entity = (id: string, clock: string) => ({ id, kind: 'stroke', notebookId: 'nb', parentId: 's', data: { clock }, hlc: clock, deleted: 0 });
async function sync(changes: unknown[], since = 0) {
  const response = await POST(req('/api/sync', { method: 'POST', session: sessionCookie(), body: { changes, since, events: [] } }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ cursor: number; changes: { id: string; hlc: string }[] }>;
}
async function waitForWriter() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await admin.query('select 1 from pg_stat_activity where application_name=$1 and lower(wait_event)=\'advisory\'', [application]);
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Writer did not wait for the sequence allocation lock');
}
async function holdingLock(): Promise<PoolClient> {
  const client = await admin.connect();
  await client.query(`set search_path to "${schema}"`);
  await client.query('begin');
  await client.query('select pg_advisory_xact_lock(72419381)');
  return client;
}
beforeAll(async () => {
  if (!connectionString) return;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Concurrency tests require a local disposable PostgreSQL server');
  configureAuthEnv();
  admin = new Pool({ connectionString });
  await admin.query(`create schema "${schema}"`);
  pool = new Pool({ connectionString, application_name: application, options: `-c search_path=${schema}` });
  const sql = { query: async <T>(text: string, values?: unknown[]) => (await pool.query(text, values)).rows as T[] };
  await migrate(sql); setSqlForTests(sql);
});
afterAll(async () => {
  if (!admin) return;
  setSqlForTests(null);
  await pool?.end();
  await admin.query(`drop schema "${schema}" cascade`);
  await admin.end();
});
suite('allocates a waiting writer sequence only after the preceding writer commits', async () => {
  const holder = await holdingLock();
  let pending: ReturnType<typeof sync> | undefined;
  try {
    pending = sync([entity('waiting', '002')]);
    await waitForWriter();
    // The waiting writer must not yet have evaluated the nextval default.
    const before = await holder.query('select is_called from entity_seq');
    expect(before.rows[0].is_called).toBe(false);
    const first = await holder.query(`insert into entities(id,kind,notebook_id,data,hlc,deleted) values('first','stroke','nb','{}','001',false) returning seq`);
    const cursor = Number(first.rows[0].seq);
    await holder.query('commit');
    const second = await pending;
    expect(second.cursor).toBeGreaterThan(cursor);
    const pulled = await sync([], cursor);
    expect(pulled.changes.map(row => row.id)).toContain('waiting');
  } finally { await holder.query('rollback'); holder.release(); await pending?.catch(() => {}); }
});
suite('returns a conflict winner committed after the losing request took its statement snapshot', async () => {
  const initial = await sync([entity('conflict', '001')]);
  const holder = await holdingLock();
  let pending: ReturnType<typeof sync> | undefined;
  try {
    const winner = await holder.query(`update entities set hlc='003',seq=nextval('entity_seq') where id='conflict' returning seq`);
    // Use the winning sequence as cursor to prove the normal pull cannot repair this.
    const cursor = Number(winner.rows[0].seq);
    expect(cursor).toBeGreaterThan(initial.cursor);
    pending = sync([entity('conflict', '002')], cursor);
    await waitForWriter();
    await holder.query('commit');
    expect((await pending).changes).toContainEqual(expect.objectContaining({ id: 'conflict', hlc: '003' }));
  } finally { await holder.query('rollback'); holder.release(); await pending?.catch(() => {}); }
});
