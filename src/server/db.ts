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
    `create table if not exists sync_config (id integer primary key check(id=1), debounce_ms integer not null check(debounce_ms between 100 and 10000))`,
    `alter table sync_config add column if not exists visible_poll_ms integer not null default 2000 check(visible_poll_ms between 100 and 30000)`,
    `alter table sync_config add column if not exists hidden_poll_ms integer not null default 15000 check(hidden_poll_ms between 1000 and 120000)`,
    `alter table sync_config add column if not exists retry_base_ms integer not null default 2000 check(retry_base_ms between 250 and 30000)`,
    `alter table sync_config drop constraint if exists sync_config_debounce_ms_check`,
    `alter table sync_config add constraint sync_config_debounce_ms_check check(debounce_ms between 0 and 10000)`,
    `alter table sync_config drop constraint if exists sync_config_visible_poll_ms_check`,
    `alter table sync_config add constraint sync_config_visible_poll_ms_check check(visible_poll_ms between 0 and 30000)`,
    `alter table sync_config drop constraint if exists sync_config_hidden_poll_ms_check`,
    `alter table sync_config add constraint sync_config_hidden_poll_ms_check check(hidden_poll_ms between 0 and 120000)`,
    `alter table sync_config drop constraint if exists sync_config_retry_base_ms_check`,
    `alter table sync_config add constraint sync_config_retry_base_ms_check check(retry_base_ms between 0 and 30000)`,
    `create table if not exists lecture_pdfs (
      id text primary key, owner text not null, notebook_id text not null,
      name text not null, size integer not null check (size > 0), ready boolean not null default false,
      created_at timestamptz not null default now()
    )`,
    `create index if not exists lecture_pdfs_owner_idx on lecture_pdfs(owner, notebook_id)`,
    `create table if not exists lecture_pdf_parts (
      attachment_id text not null references lecture_pdfs(id) on delete cascade,
      part integer not null, data text not null, primary key(attachment_id, part)
    )`,
    `create table if not exists lecture_pdf_notebooks (attachment_id text not null references lecture_pdfs(id) on delete cascade, notebook_id text not null, primary key(attachment_id, notebook_id))`,
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
