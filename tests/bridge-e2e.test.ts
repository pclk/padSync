import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as claim } from "@/app/api/bridge/claim/route";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { GET as whoami } from "@/app/api/bridge/whoami/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { POST as createJobRoute } from "@/app/api/jobs/route";
import { getSql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { PNG_DATA_URL, configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// The real bridge CLI, as a separate process, talking HTTP to the real route handlers (backed by
// PGlite) and running a fake `claude` that behaves like `claude -p --output-format stream-json`.

const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Claude)"); process.exit(0); }
const fs = await import("node:fs");
let prompt = "";
for await (const c of process.stdin) prompt += c;
const sawImage = fs.existsSync("section.png") && fs.readFileSync("section.png").subarray(1, 4).toString() === "PNG";
const sawContext = fs.existsSync("context.md") && fs.readFileSync("context.md", "utf8").includes("Evaluate");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Checking line 3" }] } });
if (prompt.includes("HANG")) await new Promise((r) => setTimeout(r, 60000));
await new Promise((r) => setTimeout(r, 4000)); // long enough to observe a progress flush
out({ type: "result", subtype: "success", is_error: false, result: "image=" + sawImage + " context=" + sawContext + " q=" + /My question:\\n(.*)/.exec(prompt)[1] });
`;

const routes: [string, RegExp, (r: NextRequest, id?: string) => Promise<Response>][] = [
  ["POST", /^\/api\/bridge\/claim$/, (r) => claim(r)],
  ["GET", /^\/api\/bridge\/whoami$/, (r) => whoami(r)],
  ["POST", /^\/api\/bridge\/jobs\/([^/]+)$/, (r, id) => bridgeUpdate(r, params({ id: id! }))],
];

let server: Server;
let base: string;
let bridge: ChildProcess | null = null;
let logs = "";
let session: string;
let disconnect = false;

async function startBridge() {
  const { sql } = await freshDb();
  const { token } = await createDeviceToken(sql, "e2e", "pclk");
  const dir = await mkdtemp(join(tmpdir(), "padsync-e2e-"));
  const fakeClaude = join(dir, "fake-claude.mjs");
  await writeFile(fakeClaude, FAKE_CLAUDE);
  await chmod(fakeClaude, 0o755);
  const cfg = join(dir, "bridge.json");
  await writeFile(cfg, JSON.stringify({ server: base, token, agents: ["claude"], claudeBin: fakeClaude }), { mode: 0o600 });
  bridge = spawn(process.execPath, [join(__dirname, "..", "bridge", "padsync-bridge.ts"), "run"], {
    env: { ...process.env, PADSYNC_BRIDGE_CONFIG: cfg, PADSYNC_SERVER: "", PADSYNC_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout!.on("data", (d) => (logs += d));
  bridge.stderr!.on("data", (d) => (logs += d));
  return token;
}

async function ask(question: string) {
  const res = await createJobRoute(req("/api/jobs", { body: { notebookId: "nb", sectionId: "s", agent: "claude", question, context: "Evaluate $x$", image: PNG_DATA_URL }, session }));
  return ((await res.json()) as { job: { id: string } }).job.id;
}

async function job(id: string) {
  const res = await getJobRoute(req(`/api/jobs/${id}`, { session }), params({ id }));
  return ((await res.json()) as { job: { status: string; output: string; error: string | null } }).job;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last=${JSON.stringify(v)}\nbridge logs:\n${logs}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeEach(async () => {
  configureAuthEnv();
  session = sessionCookie();
  logs = "";
  disconnect = false;
  server = createServer(async (inReq, out) => {
    if (disconnect) { inReq.socket.destroy(); return; }
    const chunks: Buffer[] = [];
    for await (const c of inReq) chunks.push(c as Buffer);
    const url = new URL(inReq.url!, base);
    const route = routes.find(([m, re]) => m === inReq.method && re.test(url.pathname));
    if (!route) return out.writeHead(404).end();
    const nreq = new NextRequest(url, { method: inReq.method, headers: inReq.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const res = await route[2](nreq, url.pathname.match(route[1])?.[1]);
    out.writeHead(res.status, Object.fromEntries(res.headers)).end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  bridge?.kill("SIGKILL");
  bridge = null;
  await new Promise((r) => server.close(r));
});

describe("bridge end to end", () => {
  it("claims a job, runs the agent with the section files, streams, and completes", async () => {
    await startBridge();
    const id = await ask("Is line 3 right?");
    const streaming = await waitFor(() => job(id), (j) => j.status === "running" && j.output.includes("Checking line 3"));
    expect(streaming.output).toBe("Checking line 3");
    const done = await waitFor(() => job(id), (j) => j.status === "done");
    expect(done.output).toBe("image=true context=true q=Is line 3 right?");
    expect(logs).not.toMatch(/psd_[A-Za-z0-9_-]{20,}/); // never logs the full token
  });

  it("stops the agent when the user cancels", async () => {
    await startBridge();
    const id = await ask("HANG please");
    await waitFor(() => job(id), (j) => j.status === "running" && j.output.length > 0);
    await cancelRoute(req(`/api/jobs/${id}/cancel`, { method: "POST", session }), params({ id }));
    await waitFor(async () => logs, (l) => l.includes("cancelled by user"));
    expect((await job(id)).status).toBe("cancelled");
  });

  it("stops a running agent and exits 2 after revocation", async () => {
    const token = await startBridge();
    const id = await ask("HANG please");
    await waitFor(() => job(id), (j) => j.output.length > 0);
    const exited = new Promise<number | null>((r) => bridge!.on("exit", r));
    await (await getSql())!.query(`update device_tokens set revoked_at = now()`);
    expect(await exited).toBe(2);
    expect(logs).not.toContain(token);
  });

  it("abandons a job after ownership is lost (409)", async () => {
    await startBridge();
    const id = await ask("HANG please");
    await waitFor(() => job(id), (j) => j.output.length > 0);
    await (await getSql())!.query(`update jobs set claimed_by = 'other' where id = $1`, [id]);
    const next = await ask("next question");
    await waitFor(() => job(next), (j) => j.status === "done", 20000);
    expect((await job(id)).output).toBe("Checking line 3");
  });

  it("backs off on network failures and recovers without leaking its token", async () => {
    disconnect = true;
    const token = await startBridge();
    await waitFor(async () => logs, (l) => l.includes("retrying in 6s"));
    expect(bridge!.exitCode).toBeNull();
    disconnect = false;
    const id = await ask("recover");
    await waitFor(() => job(id), (j) => j.status === "done");
    expect(logs).not.toContain(token);
  });

  it("exits with code 2 when its token is revoked", async () => {
    await startBridge();
    await waitFor(async () => logs, (l) => l.includes("polling"));
    const sql = await getSql();
    await sql!.query(`update device_tokens set revoked_at = now()`);
    const code = await new Promise<number | null>((r) => bridge!.on("exit", r));
    expect(code).toBe(2);
    expect(logs).toContain("device token was rejected");
  });
});
