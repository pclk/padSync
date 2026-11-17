import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt, prepareJobDir, runAgent, sweepStaleJobDirs, withJobDir } from "../bridge/lib.ts";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "sol-review-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("additional job directory coverage", () => {
  it("canonicalizes a symlinked temp root, including spaces", async () => {
    const target = join(root, "real temp");
    const alias = join(root, "alias temp");
    await mkdir(target);
    await symlink(target, alias);
    const d = await prepareJobDir({ image: null, context: "private" }, alias);
    expect(d.dir.startsWith(target + "/padsync-job-")).toBe(true);
    expect(await readFile(d.context!, "utf8")).toBe("private");
    expect((await stat(d.context!)).mode & 0o777).toBe(0o600);
  });

  it("cleans nested agent artifacts without following an internal symlink", async () => {
    const keep = join(root, "keep");
    await mkdir(keep);
    await writeFile(join(keep, "secret"), "untouched");
    await withJobDir({ image: null, context: "input" }, async (d) => {
      await mkdir(join(d.dir, "nested"));
      await writeFile(join(d.dir, "nested", "final.md"), "answer");
      await symlink(keep, join(d.dir, "external"));
    }, root);
    expect(await readdir(root)).toEqual(["keep"]);
    expect(await readFile(join(keep, "secret"), "utf8")).toBe("untouched");
  });

  it("cleans up after a pre-aborted run", async () => {
    const signal = AbortSignal.abort();
    const result = await withJobDir({ image: null, context: "input" }, (d) => runAgent({
      cwd: d.dir, prompt: "", signal, timeoutMs: 5000, onText: () => {},
      command: { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], parse: () => null },
    }), root);
    expect(result.status).toBe("cancelled");
    expect(await readdir(root)).toEqual([]);
  });

  it("sweeps nested leftovers without following their internal symlinks", async () => {
    const old = join(root, "padsync-job-old");
    const target = join(root, "unrelated");
    await mkdir(old);
    await mkdir(target);
    await writeFile(join(target, "keep"), "keep");
    await symlink(target, join(old, "external"));
    const now = Date.now();
    await utimes(old, new Date(now - 7200_000), new Date(now - 7200_000));
    expect(await sweepStaleJobDirs(3600_000, root, now)).toBe(1);
    expect(await readFile(join(target, "keep"), "utf8")).toBe("keep");
  });

  it("handles concurrent sweepers without deleting fresh jobs", async () => {
    const fresh = await prepareJobDir({ image: null, context: "live" }, root);
    const old = join(root, "padsync-job-old");
    await mkdir(old);
    const now = Date.now();
    await utimes(old, new Date(now - 7200_000), new Date(now - 7200_000));
    await Promise.all([sweepStaleJobDirs(3600_000, root, now), sweepStaleJobDirs(3600_000, root, now)]);
    expect(await readdir(root)).toEqual([fresh.dir.slice(root.length + 1)]);
    expect(await readFile(fresh.context!, "utf8")).toBe("live");
  });

  it("still directs Codex to read context when a job has no image", () => {
    const prompt = buildAgentPrompt("Q", { context: "/tmp/context.md" }, "codex");
    expect(prompt).toContain("Read the text file before answering");
    expect(prompt).toContain("/tmp/context.md");
  });
});

// Regression: SIGTERM exits while claim is in flight, abandoning a server-claimed job.
// Fixed: shutdown waits for the in-flight claim and reports the returned job as stopped.
it("reports a job claimed during shutdown before exiting", async () => {
  let claimed!: () => void;
  const claimSeen = new Promise<void>((r) => { claimed = r; });
  let updates = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url === "/api/bridge/claim") {
      claimed(); // Model a committed claim whose response has not reached the bridge.
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ job: {
        id: "claimed", agent: "claude", question: "Q", context: "private", image: null,
      } })), 200);
    } else {
      updates++;
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"error","cancelled":false}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as { port: number };
  const cfg = join(root, "bridge.json");
  await writeFile(cfg, JSON.stringify({ server: `http://127.0.0.1:${addr.port}`, token: "test", agents: ["claude"], claudeBin: process.execPath }));
  const child = spawn(process.execPath, [resolve("bridge/padsync-bridge.ts"), "run"], {
    env: { ...process.env, TMPDIR: root, PADSYNC_BRIDGE_CONFIG: cfg, PADSYNC_SERVER: "", PADSYNC_TOKEN: "" }, stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    await claimSeen;
    child.kill("SIGTERM");
    await exited;
    expect(updates).toBe(1);
  } finally {
    child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Regression: a hung progress request used to hold shutdown past its 10 s hard exit, so the
// "bridge stopped" report was never sent.
it("reports the job and exits 0 on SIGTERM even while a progress request hangs", async () => {
  const fake = join(root, "fake-claude.mjs");
  await writeFile(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1"); process.exit(0); }
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } }));
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
  let claims = 0;
  let progressSeen!: () => void;
  const progress = new Promise<void>((r) => { progressSeen = r; });
  const finals: { status?: string; error?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.url === "/api/bridge/claim") {
      return json({ job: claims++ ? null : { id: "j1", agent: "claude", question: "Q", context: "ctx", image: null } });
    }
    const u = JSON.parse(body);
    if (u.status) { finals.push(u); return json({ status: u.status, cancelled: false }); }
    progressSeen(); // never answer progress updates
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const cfg = join(root, "bridge.json");
  await writeFile(cfg, JSON.stringify({ server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t", agents: ["claude"], claudeBin: fake }));
  const child = spawn(process.execPath, [resolve("bridge/padsync-bridge.ts"), "run"], {
    env: { ...process.env, TMPDIR: root, PADSYNC_BRIDGE_CONFIG: cfg, PADSYNC_SERVER: "", PADSYNC_TOKEN: "" }, stdio: "ignore",
  });
  try {
    await progress;
    const started = Date.now();
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    expect((await exited)[0]).toBe(0);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(finals).toEqual([expect.objectContaining({ status: "error", error: expect.stringMatching(/bridge was stopped/) })]);
    expect((await readdir(root)).filter((n) => n.startsWith("padsync-job-"))).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
