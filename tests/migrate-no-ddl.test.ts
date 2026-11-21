import { expect, it } from 'vitest';
import { migrate, type Sql } from '@/server/db';
import { freshDb } from './helpers/env';

// Any catalog write resets Neon Realtime's pipeline, so a cold start on a current schema must not run DDL.
it('runs no DDL once the schema is current, and again when it is not', async () => {
  const { sql, pg } = await freshDb();
  try {
    const texts: string[] = [];
    const recording: Sql = { query: (text, params) => { texts.push(text); return sql.query(text, params); } };
    await migrate(recording);
    expect(texts.filter((t) => /^\s*(alter|create|drop)\b/i.test(t))).toEqual([]);
    expect(texts.some((t) => /delete from job_inputs/.test(t))).toBe(true);
    texts.length = 0;
    await sql.query(`update schema_state set hash = 'old'`);
    await migrate(recording);
    expect(texts.some((t) => /^\s*alter table sync_config/i.test(t))).toBe(true);
  } finally { await pg.close(); }
});
