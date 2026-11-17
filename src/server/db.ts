import "server-only";
import { neon } from "@neondatabase/serverless";

// Neon over HTTP: one round trip per query, no connection pool to manage on Vercel.
// The schema is created on first use so a fresh Neon integration works without a migrate step.
// Each query runs as its own transaction; multi-step invariants live in single statements.

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs parameterless statements in one round trip (one transaction) where the driver can. */
  batch?(texts: string[]): Promise<void>;
}

let client: Sql | null = null;
let ready: Promise<void> | null = null;

export function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null;
}

export async function getSql(): Promise<Sql | null> {
  if (!client) {
    const url = databaseUrl();
    if (!url) return null;
    const neonSql = neon(url);
    client = {
      query: (text, params) => neonSql.query(text, params ?? []) as never,
      batch: async (texts) => {
        await neonSql.transaction(texts.map((t) => neonSql.query(t)));
      },
    };
  }
  ready ??= migrate(client).catch((e) => {
    ready = null;
    throw e;
  });
  await ready;
  return client;
}

/** Tests swap in an in-process Postgres (PGlite). Pass null to reset. */
export function setSqlForTests(sql: Sql | null) {
  client = sql;
  ready = null;
}

export async function migrate(sql: Sql) {
  // Cold starts pay for this, so on Neon it is one HTTP round trip rather than one per statement.
  const ddl = [
    `create sequence if not exists entity_seq`,
    `
    create table if not exists entities (
      id text primary key,
      kind text not null,
      notebook_id text not null,
      parent_id text not null default '',
      data jsonb not null,
      hlc text not null,
      deleted boolean not null default false,
      seq bigint not null default nextval('entity_seq'),
      updated_at timestamptz not null default now()
    )`,
    `create index if not exists entities_seq_idx on entities (seq)`,
    `create index if not exists entities_notebook_idx on entities (notebook_id, kind)`,
    `
    create table if not exists events (
      id text primary key,
      notebook_id text not null,
      section_id text,
      type text not null,
      t bigint not null,
      device text not null,
      data jsonb not null,
      received_at timestamptz not null default now()
    )`,
    `create index if not exists events_section_idx on events (section_id, t)`,
    `
    create table if not exists device_tokens (
      id text primary key,
      name text not null,
      token_hash text not null unique,
      hint text not null,
      created_by text not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz,
      last_seen_info jsonb,
      revoked_at timestamptz
    )`,
    `
    create table if not exists jobs (
      id text primary key,
      notebook_id text not null,
      section_id text,
      agent text not null,
      question text not null,
      context text not null default '',
      image text,
      status text not null default 'queued',
      output text not null default '',
      error text,
      claimed_by text,
      claimed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      finished_at timestamptz
    )`,
    `alter table jobs add column if not exists options jsonb not null default '{}'::jsonb`,
    `alter table jobs add column if not exists files jsonb`,
    `alter table jobs add column if not exists result_files jsonb`,
    `alter table jobs add column if not exists kind text not null default 'ask'`,
    `alter table jobs add column if not exists uploads jsonb`,
    `
    create table if not exists job_inputs (
      job_id text not null,
      path text not null,
      part integer not null,
      data text not null,
      primary key (job_id, path, part)
    )`,
    `create index if not exists jobs_queue_idx on jobs (status, created_at)`,
    `create index if not exists jobs_section_idx on jobs (section_id, created_at)`,
    // Jobs finished before image/context were dropped on completion (see jobs.ts).
    `update jobs set image = null, context = '', files = null where status in ('done', 'error', 'cancelled') and (image is not null or context <> '' or files is not null)`,
    // Imports abandoned mid-upload (tab closed), and parts left by jobs that already finished.
    `update jobs set status = 'cancelled', finished_at = now(), updated_at = now(), files = null where status = 'uploading' and updated_at < now() - interval '1 day'`,
    `delete from job_inputs where job_id not in (select id from jobs where status in ('uploading', 'queued', 'running'))`,
  ];
  if (sql.batch) await sql.batch(ddl);
  else for (const text of ddl) await sql.query(text);
}
