import "server-only";
import { neon } from "@neondatabase/serverless";

// Neon over HTTP: one round trip per query, no connection pool to manage on Vercel.
// The schema is created on first use so a fresh Neon integration works without a migrate step.
// Each query runs as its own transaction; multi-step invariants live in single statements.

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
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
    client = { query: (text, params) => neonSql.query(text, params ?? []) as never };
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
  await sql.query(`create sequence if not exists entity_seq`);
  await sql.query(`
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
    )`);
  await sql.query(`create index if not exists entities_seq_idx on entities (seq)`);
  await sql.query(`create index if not exists entities_notebook_idx on entities (notebook_id, kind)`);
  await sql.query(`
    create table if not exists events (
      id text primary key,
      notebook_id text not null,
      section_id text,
      type text not null,
      t bigint not null,
      device text not null,
      data jsonb not null,
      received_at timestamptz not null default now()
    )`);
  await sql.query(`create index if not exists events_section_idx on events (section_id, t)`);
  await sql.query(`
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
    )`);
  await sql.query(`
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
    )`);
  await sql.query(`create index if not exists jobs_queue_idx on jobs (status, created_at)`);
  await sql.query(`create index if not exists jobs_section_idx on jobs (section_id, created_at)`);
}
