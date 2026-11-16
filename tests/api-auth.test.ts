import { beforeEach, describe, expect, it } from "vitest";
import { POST as claim } from "@/app/api/bridge/claim/route";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { GET as whoami } from "@/app/api/bridge/whoami/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/jobs/route";
import { POST as sync } from "@/app/api/sync/route";
import { DELETE as revokeRoute } from "@/app/api/tokens/[id]/route";
import { GET as listTokensRoute, POST as createTokenRoute } from "@/app/api/tokens/route";
import type { Sql } from "@/server/db";
import { setSqlForTests } from "@/server/db";
import { configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// Who may call what. Sessions (GitHub, browser) and device tokens (bridge) are disjoint.

let sql: Sql;
let session: string;

async function newToken(name = "Mac bridge") {
  const res = await createTokenRoute(req("/api/tokens", { body: { name }, session }));
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; record: { id: string } };
}

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
});

describe("token management requires a GitHub session", () => {
  it("rejects anonymous callers", async () => {
    expect((await listTokensRoute(req("/api/tokens"))).status).toBe(401);
    expect((await createTokenRoute(req("/api/tokens", { body: { name: "x" } }))).status).toBe(401);
  });

  it("rejects a session for another GitHub user", async () => {
    const other = sessionCookie("someone-else");
    expect((await listTokensRoute(req("/api/tokens", { session: other }))).status).toBe(401);
  });

  it("rejects a session signed with a different secret", async () => {
    const forged = sessionCookie();
    process.env.SESSION_SECRET = "rotated";
    expect((await listTokensRoute(req("/api/tokens", { session: forged }))).status).toBe(401);
  });

  it("creates a token, shows plaintext once, never in listings", async () => {
    const { token, record } = await newToken();
    expect(token).toMatch(/^psd_/);
    const res = await listTokensRoute(req("/api/tokens", { session }));
    const body = await res.text();
    expect(body).toContain(record.id);
    expect(body).not.toContain(token);
  });

  it("validates the token name", async () => {
    expect((await createTokenRoute(req("/api/tokens", { body: { name: "" }, session }))).status).toBe(400);
    expect((await createTokenRoute(req("/api/tokens", { body: { name: "x".repeat(61) }, session }))).status).toBe(400);
  });

  it("a device token cannot mint or list tokens, even alongside a session", async () => {
    const { token } = await newToken();
    expect((await createTokenRoute(req("/api/tokens", { body: { name: "evil" }, bearer: token }))).status).toBe(403);
    expect((await listTokensRoute(req("/api/tokens", { bearer: token }))).status).toBe(403);
    expect((await listTokensRoute(req("/api/tokens", { bearer: token, session }))).status).toBe(403);
  });

  it("revokes via session; revoked token stops working at once", async () => {
    const { token, record } = await newToken();
    expect((await whoami(req("/api/bridge/whoami", { bearer: token }))).status).toBe(200);
    expect((await revokeRoute(req(`/api/tokens/${record.id}`, { method: "DELETE", session }), params({ id: record.id }))).status).toBe(204);
    expect((await whoami(req("/api/bridge/whoami", { bearer: token }))).status).toBe(401);
    expect((await revokeRoute(req(`/api/tokens/${record.id}`, { method: "DELETE", session }), params({ id: record.id }))).status).toBe(404);
  });

  it("a device token cannot revoke tokens", async () => {
    const { token, record } = await newToken();
    expect((await revokeRoute(req(`/api/tokens/${record.id}`, { method: "DELETE", bearer: token }), params({ id: record.id }))).status).toBe(403);
  });
});

describe("device tokens are scoped to the bridge API", () => {
  it("cannot sync notebooks", async () => {
    const { token } = await newToken();
    expect((await sync(req("/api/sync", { body: { since: 0, changes: [], events: [] }, bearer: token }))).status).toBe(403);
  });

  it("cannot create or list jobs", async () => {
    const { token } = await newToken();
    const job = { notebookId: "n", sectionId: "s", agent: "claude", question: "q" };
    expect((await createJobRoute(req("/api/jobs", { body: job, bearer: token }))).status).toBe(403);
    expect((await listJobsRoute(req("/api/jobs?sectionId=s", { bearer: token }))).status).toBe(403);
  });

  it("a session cannot use bridge endpoints", async () => {
    expect((await claim(req("/api/bridge/claim", { body: { agents: ["claude"] }, session }))).status).toBe(401);
    expect((await whoami(req("/api/bridge/whoami", { session }))).status).toBe(401);
    expect((await bridgeUpdate(req("/api/bridge/jobs/x", { body: { output: "hi" }, session }), params({ id: "x" }))).status).toBe(401);
  });

  it("rejects garbage, wrong-scheme and unknown tokens", async () => {
    for (const headers of [{ authorization: "Bearer nope" }, { authorization: "Basic cHNkXzpw" }, { authorization: `Bearer psd_${"A".repeat(43)}` }]) {
      expect((await claim(req("/api/bridge/claim", { body: { agents: ["claude"] }, headers }))).status).toBe(401);
    }
  });

  it("authenticates before validating the body", async () => {
    expect((await claim(req("/api/bridge/claim", { body: { agents: [] } }))).status).toBe(401);
    const { token } = await newToken();
    expect((await claim(req("/api/bridge/claim", { body: { agents: [] }, bearer: token }))).status).toBe(400);
  });

  it("whoami identifies the device", async () => {
    const { token, record } = await newToken("Studio Mac");
    const res = await whoami(req("/api/bridge/whoami", { bearer: token }));
    expect(await res.json()).toEqual({ device: { id: record.id, name: "Studio Mac" } });
  });
});

describe("without a database", () => {
  it("returns 503 rather than leaking errors", async () => {
    setSqlForTests(null);
    const url = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    try {
      expect((await listTokensRoute(req("/api/tokens", { session }))).status).toBe(503);
      expect((await claim(req("/api/bridge/claim", { body: { agents: ["claude"] }, bearer: "psd_x" }))).status).toBe(503);
    } finally {
      if (url) process.env.DATABASE_URL = url;
      setSqlForTests(sql);
    }
  });
});
