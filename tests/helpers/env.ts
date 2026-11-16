import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/server/auth";
import { migrate, setSqlForTests, type Sql } from "@/server/db";

// Real Postgres (PGlite, in-process WASM) behind the same Sql interface the app uses with Neon.

export async function freshDb(): Promise<{ sql: Sql; pg: PGlite }> {
  const pg = new PGlite();
  const sql: Sql = { query: async (text, params) => (await pg.query(text, params ?? [])).rows as never };
  await migrate(sql);
  setSqlForTests(sql);
  return { sql, pg };
}

export function configureAuthEnv() {
  process.env.GITHUB_CLIENT_ID = "test-client";
  process.env.GITHUB_CLIENT_SECRET = "test-secret";
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.ALLOWED_GITHUB_LOGIN;
}

export function sessionCookie(login = "pclk") {
  return `${SESSION_COOKIE}=${createSession(login)}`;
}

interface ReqOpts {
  method?: string;
  body?: unknown;
  session?: string | false;
  bearer?: string;
  headers?: Record<string, string>;
}

export function req(path: string, o: ReqOpts = {}) {
  const headers = new Headers(o.headers);
  if (o.body !== undefined) headers.set("content-type", "application/json");
  if (o.session !== false && o.session !== undefined) headers.set("cookie", o.session);
  if (o.bearer) headers.set("authorization", `Bearer ${o.bearer}`);
  return new NextRequest(new URL(path, "https://pad.test"), {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

export const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
