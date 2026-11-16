import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Neon over HTTP: one round trip per query, no connection pool to manage on Vercel.
// The schema is created on first use so a fresh Neon integration works without a migrate step.

let client: NeonQueryFunction<false, false> | null = null;
let ready: Promise<void> | null = null;

export function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null;
}

export async function getSql() {
  const url = databaseUrl();
  if (!url) return null;
  client ??= neon(url);
  ready ??= migrate(client).catch((e) => {
    ready = null;
    throw e;
  });
  await ready;
  return client;
}

async function migrate(sql: NeonQueryFunction<false, false>) {
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
}
