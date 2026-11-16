import { afterEach, expect, it } from "vitest";
import { freshDb, configureAuthEnv, req, sessionCookie } from "./helpers/env";
import { POST as canvasStatus } from "@/app/api/canvas/status/route";
import { requireSession } from "@/server/guard";
import { createDeviceToken, listDeviceTokens } from "@/server/tokens";
import { createJob, claimJob, updateJob, cancelJob, getJob } from "@/server/jobs";
import { BridgeApi, agentEnv } from "../bridge/lib";
import type { PGlite } from "@electric-sql/pglite";
let pg: PGlite | undefined;
afterEach(async () => { await pg?.close(); pg = undefined; });
it.each(["Bearer", "bearer x y", "BEARER x, Bearer y"])("rejects malformed bearer alongside session: %s", async (authorization) => {
  ({ pg } = await freshDb());
  configureAuthEnv();
  const result = await requireSession(req("/api/tokens", { session: sessionCookie(), headers: { authorization } }));
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(403);
});
it("lists only a four-character token hint", async () => {
  const db = await freshDb(); pg = db.pg;
  const { token, record } = await createDeviceToken(db.sql, "test", "pclk");
  expect(record.hint).toBe(token.slice(4, 8));
  expect(record.hint).toHaveLength(4);
  expect(JSON.stringify(await listDeviceTokens(db.sql))).not.toContain(token);
});
it("caps bridge answers before sending to the validating API", async () => {
  let body = "";
  const api = new BridgeApi({ server: "https://example.test", token: "secret" }, async (_url, init) => {
    body = String(init?.body);
    return Response.json({ status: "done", cancelled: false });
  });
  await api.update("job", { status: "done", output: "x".repeat(200001) });
  expect(JSON.parse(body).output).toHaveLength(200000);
});
for (const state of ["queued", "running", "done", "error", "cancelled"] as const) {
  for (const action of ["claim", "update", "heartbeat", "done", "error", "cancel"] as const) {
    it(`${state} × ${action}`, async () => {
      const db = await freshDb(); pg = db.pg;
      const job = await createJob(db.sql, { notebookId: "n", sectionId: null, agent: "claude", question: "q", context: "", image: null });
      if (state !== "queued") await claimJob(db.sql, "a", ["claude"]);
      if (state === "done" || state === "error") await updateJob(db.sql, job.id, "a", { status: state });
      if (state === "cancelled") await cancelJob(db.sql, job.id);
      if (action === "claim") expect(!!await claimJob(db.sql, "b", ["claude"])).toBe(state === "queued");
      else if (action === "cancel") expect(!!await cancelJob(db.sql, job.id)).toBe(state === "queued" || state === "running");
      else {
        const u = action === "update" ? { output: "answer" } : action === "heartbeat" ? {} : { status: action };
        const result = await updateJob(db.sql, job.id, "a", u);
        expect(result.ok).toBe(state === "running");
        if (state !== "running") expect((await getJob(db.sql, job.id))?.status).toBe(state);
      }
    });
  }
}

it("canvas status rejects bearer even alongside a session", async () => {
  configureAuthEnv();
  expect((await canvasStatus(req("/api/canvas/status", { session: sessionCookie(), bearer: "x" }))).status).toBe(403);
});

it("refuses cross-origin state changes on session endpoints, allows same-origin and reads", async () => {
  ({ pg } = await freshDb());
  configureAuthEnv();
  const session = sessionCookie();
  const post = (origin?: string) => requireSession(req("/api/tokens", { body: { name: "x" }, session, headers: origin ? { origin } : {} }));
  expect(((await post("https://evil.test")) as Response).status).toBe(403);
  expect(await post("https://pad.test")).not.toBeInstanceOf(Response);
  expect(await post()).not.toBeInstanceOf(Response); // same-origin fetches may omit Origin
  const get = await requireSession(req("/api/tokens", { session, headers: { origin: "https://evil.test" } }));
  expect(get).not.toBeInstanceOf(Response);
});

it("agents never inherit padSync credentials", () => {
  const env = agentEnv({ PATH: "/bin", HOME: "/h", PADSYNC_TOKEN: "psd_secret", PADSYNC_SERVER: "https://x", PADSYNC_BRIDGE_CONFIG: "/c" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
});
