import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentCommand, buildImportPrompt, fetchUploads } from "../bridge/lib";
import { POST as claim } from "@/app/api/bridge/claim/route";
import { GET as bridgeInput } from "@/app/api/bridge/jobs/[id]/inputs/route";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { GET as whoami } from "@/app/api/bridge/whoami/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { PUT as putInput } from "@/app/api/jobs/[id]/inputs/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { POST as createJobRoute } from "@/app/api/jobs/route";
import { DEFAULT_CONFIG, pickResult, reviewPayload, type ReturnedFile } from "@/lib/ai-import";
import { sendImport } from "@/lib/import-send";
import { PART_CHARS } from "@/lib/uploads";
import type { Sql } from "@/server/db";
import { createDeviceToken } from "@/server/tokens";
import { PNG_DATA_URL, configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// AI import through the bridge: lecture files uploaded in parts, fetched by the real bridge CLI,
// written to the per-job temp dir, read by a fake `claude`, which writes out/padsync.json and a
// figure. The temp dir must be gone afterwards on success, error and cancel.

describe("bridge import helpers", () => {
  // Import dispatch forces allowEdits so the agent can deliver out/padsync.json.
  const values = (args: string[], flag: string) => {
    const start = args.indexOf(flag);
    if (start < 0) return [];
    const rest = args.slice(start + 1);
    const end = rest.findIndex((v) => v.startsWith("--"));
    return end < 0 ? rest : rest.slice(0, end);
  };

  it.each([false, true])("Claude import grants file delivery with optional Bash=%s, independently of web", (allowCode) => {
    for (const webSearch of [false, true]) {
      const { args } = agentCommand("claude", {}, false, { allowEdits: true, allowCode, webSearch });
      const tools = ["Read", "Glob", "Grep", "Write", "Edit", ...(allowCode ? ["Bash"] : []), ...(webSearch ? ["WebSearch", "WebFetch"] : [])];
      expect(values(args, "--tools")).toEqual([tools.join(",")]);
      expect(values(args, "--allowedTools")).toEqual(tools.filter((t) => !["Write", "Edit"].includes(t)));
      expect(values(args, "--disallowedTools")).toEqual(["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"].filter((t) => !tools.includes(t)));
      expect(values(args, "--permission-mode")).toEqual(["acceptEdits"]);
      expect(args).toContain("--strict-mcp-config");
      expect(args).not.toContain("--dangerously-skip-permissions");
      if (allowCode) {
        expect(JSON.parse(values(args, "--settings")[0])).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
      } else expect(args).not.toContain("--settings");
    }
    const ask = agentCommand("claude", {}, false).args;
    expect(values(ask, "--tools")).toEqual(["Read"]);
    expect(ask).not.toContain("--permission-mode");
  });

  it("Codex import needs workspace writes; code is intrinsic and search remains optional", () => {
    for (const webSearch of [false, true]) {
      const args = agentCommand("codex", {}, ["lectures/board.png"], { allowEdits: true, webSearch }).args;
      expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
      expect(args.includes("--search")).toBe(webSearch);
      if (webSearch) expect(args.indexOf("--search")).toBeLessThan(args.indexOf("exec"));
      expect(args.slice(-2)).toEqual(["--image", "lectures/board.png"]);
      expect(args.join(" ")).not.toMatch(/danger-full-access|dangerously/);
    }
    const ask = agentCommand("codex", {}, false).args;
    expect(ask[ask.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("fetchUploads reassembles parts and checks sizes", async () => {
    const data: Record<string, string[]> = { "lectures/01-a.pdf": ["AAAA", "BB=="], "lectures/02-b.png": ["CCCC"] };
    const api = { input: async (_id: string, path: string, part: number) => ({ data: data[path][part] }) };
    const files = await fetchUploads(api, { id: "j", uploads: [{ path: "lectures/01-a.pdf", mime: "application/pdf", size: 8, parts: 2 }, { path: "lectures/02-b.png", mime: "image/png", size: 4, parts: 1 }] });
    expect(files).toEqual([{ path: "lectures/01-a.pdf", mime: "application/pdf", base64: "AAAABB==" }, { path: "lectures/02-b.png", mime: "image/png", base64: "CCCC" }]);
    await expect(fetchUploads(api, { id: "j", uploads: [{ path: "lectures/01-a.pdf", mime: "application/pdf", size: 12, parts: 2 }] })).rejects.toThrow(/arrived with 8 of 12/);
    await expect(fetchUploads(api, { id: "j", uploads: [{ path: "../x", mime: "application/pdf", size: 4, parts: 1 }] })).rejects.toThrow(/unsafe file name/);
    const bad = { input: async () => ({ data: "<html>" }) };
    await expect(fetchUploads(bad, { id: "j", uploads: [{ path: "lectures/a.pdf", mime: "application/pdf", size: 4, parts: 1 }] })).rejects.toThrow(/not base64/);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchUploads(api, { id: "j", uploads: [{ path: "lectures/01-a.pdf", mime: "application/pdf", size: 8, parts: 2 }] }, ac.signal)).rejects.toThrow();
  });

  it("the import prompt names files by path, says where to write, and never inlines content", () => {
    const d = { dir: "/tmp/padsync-job-x", out: "/tmp/padsync-job-x/out", files: [{ path: "INSTRUCTIONS.md", mime: "text/markdown" }, { path: "request.md", mime: "text/markdown" }, { path: "lectures/01-l9.pdf", mime: "application/pdf" }, { path: "lectures/02-deck.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, { path: "lectures/03-board.jpg", mime: "image/jpeg" }] };
    const claude = buildImportPrompt("Notes for L9", d, "claude");
    expect(claude).toContain("`/tmp/padsync-job-x/INSTRUCTIONS.md`: the padSync format");
    expect(claude).toContain("`/tmp/padsync-job-x/lectures/01-l9.pdf`: lecture material");
    expect(claude).toContain("lectures/02-deck.pptx`: lecture material (an Office file");
    expect(claude).toContain("/tmp/padsync-job-x/out/padsync.json");
    expect(claude).toContain("/tmp/padsync-job-x/out/figures/");
    expect(claude).toMatch(/Read request.md first.*selected PDF page ranges/);
    expect(claude).toContain("otherwise read all pages");
    expect(claude).toMatch(/you may not run here/); // pptx without allowCode
    expect(buildImportPrompt("x", d, "claude", { allowCode: true })).toMatch(/check that the file parses as JSON/);
    const codex = buildImportPrompt("x", d, "codex");
    expect(codex).toContain("03-board.jpg`: lecture material (also attached)");
    expect(codex).toMatch(/pdftotext/);
  });
});

const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Claude)"); process.exit(0); }
const fs = await import("node:fs");
let prompt = "";
for await (const c of process.stdin) prompt += c;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init" });
// Leave partial output behind before failure/cancel to exercise recursive cleanup.
fs.writeFileSync("out/partial.txt", "unfinished");
if (prompt.includes("FAIL")) { console.error("agent blew up"); process.exit(3); }
if (prompt.includes("HANG")) await new Promise((r) => setTimeout(r, 60000));
const lectures = fs.readdirSync("lectures").sort();
const pdf = fs.readFileSync("lectures/" + lectures[0]);
const instructions = fs.readFileSync("INSTRUCTIONS.md", "utf8");
const request = fs.readFileSync("request.md", "utf8");
if (prompt.includes(instructions) || prompt.includes(request) || prompt.includes(pdf.toString("base64"))) {
  console.error("document content was inlined"); process.exit(4);
}
fs.unlinkSync("out/partial.txt");
fs.mkdirSync("out/figures");
fs.writeFileSync("out/figures/graph.png", Buffer.from(process.env.FAKE_PNG, "base64"));
fs.writeFileSync("out/padsync.json", JSON.stringify({
  schemaVersion: 2, title: "From " + lectures.join(","), sections: [
    { title: "Notes", kind: "notes", blocks: [{ type: "cloze", text: "Bytes: {{" + pdf.length + "}} starting " + pdf.subarray(0, 5).toString() }, { type: "image", src: "figures/graph.png" }] },
    { title: "Q1", kind: "problem", blocks: [{ type: "markdown", text: "Q" }, { type: "space", size: "m" }], solution: "s" },
  ],
}));
const tools = process.argv[process.argv.indexOf("--tools") + 1];
out({ type: "result", subtype: "success", is_error: false, result: "made 2 sections; schema=" + instructions.includes('"schemaVersion": 2') + " names=" + request.includes("Lecture 9.pdf") + " tools=" + tools + " byPath=" + prompt.includes(process.cwd() + "/lectures/") });
`;

let server: Server;
let base: string;
let bridge: ChildProcess | null = null;
let logs = "";
let session: string;
let jobTmp = "";
let sql: Sql;
const leftovers = async () => (await readdir(jobTmp)).filter((n) => n.startsWith("padsync-job-"));

const routes: [string, RegExp, (r: NextRequest, id?: string) => Promise<Response>][] = [
  ["POST", /^\/api\/bridge\/claim$/, (r) => claim(r)],
  ["GET", /^\/api\/bridge\/whoami$/, (r) => whoami(r)],
  ["GET", /^\/api\/bridge\/jobs\/([^/]+)\/inputs$/, (r, id) => bridgeInput(r, params({ id: id! }))],
  ["POST", /^\/api\/bridge\/jobs\/([^/]+)$/, (r, id) => bridgeUpdate(r, params({ id: id! }))],
];

async function startBridge() {
  const { token } = await createDeviceToken(sql, "e2e", "pclk");
  const dir = await mkdtemp(join(tmpdir(), "padsync-import-e2e-"));
  const fake = join(dir, "fake-claude.mjs");
  await writeFile(fake, FAKE_CLAUDE);
  await chmod(fake, 0o755);
  jobTmp = join(await realpath(dir), "tmp");
  await mkdir(jobTmp);
  const cfg = join(dir, "bridge.json");
  await writeFile(cfg, JSON.stringify({ server: base, token, agents: ["claude"], claudeBin: fake }), { mode: 0o600 });
  bridge = spawn(process.execPath, [join(__dirname, "..", "bridge", "padsync-bridge.ts"), "run"], {
    env: { ...process.env, TMPDIR: jobTmp, PADSYNC_BRIDGE_CONFIG: cfg, PADSYNC_SERVER: "", PADSYNC_TOKEN: "", FAKE_PNG: PNG_DATA_URL.split(",")[1] },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout!.on("data", (d) => (logs += d));
  bridge.stderr!.on("data", (d) => (logs += d));
}

// The browser half, through the same routes as the page uses.
const pageFetch = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url, "https://pad.test");
  const body = init.body ? JSON.parse(init.body as string) : undefined;
  const m = /^\/api\/jobs\/([^/]+)\/(inputs|cancel)$/.exec(u.pathname);
  if (m?.[2] === "inputs") return putInput(req(u.pathname, { method: "PUT", body, session }), params({ id: m[1] }));
  if (m) return cancelRoute(req(u.pathname, { method: "POST", session }), params({ id: m[1] }));
  return createJobRoute(req(u.pathname, { body, session }));
}) as typeof fetch;

type JobView = { status: string; output: string; error: string | null; resultFiles: ReturnedFile[] };
async function job(id: string) {
  const res = await getJobRoute(req(`/api/jobs/${id}`, { session }), params({ id }));
  return ((await res.json()) as { job: JobView }).job;
}
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last=${JSON.stringify(v).slice(0, 500)}\nbridge logs:\n${logs}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// A "PDF" bigger than one part, so the bridge has to fetch and join several.
const bigPdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(PART_CHARS, 7)]);
const lecture = (name: string, buf = bigPdf) => ({ meta: { name, mime: "application/pdf" as const, kind: "pdf" as const, size: buf.length }, base64: async () => buf.toString("base64") });

beforeEach(async () => {
  configureAuthEnv();
  ({ sql } = await freshDb());
  session = sessionCookie();
  logs = "";
  server = createServer(async (inReq, out) => {
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

describe("AI import end to end", () => {
  it("uploads lecture files, the bridge assembles them in the temp dir, and the result imports", async () => {
    await startBridge();
    const { jobId } = await sendImport({ config: { ...DEFAULT_CONFIG, request: "Notes for L9" }, attachments: [lecture("Lecture 9.pdf"), lecture("tiny.pdf", Buffer.from("%PDF-tiny"))], fetch: pageFetch });
    const done = await waitFor(() => job(jobId), (j) => j.status === "done" || j.status === "error");
    expect(done.error).toBeNull();
    expect(done.output).toContain("made 2 sections; schema=true names=true");
    expect(done.output).toContain("byPath=true");
    expect(done.output).toMatch(/tools=Read,Glob,Grep,Write,Edit\b/); // import may always write to out/
    expect(done.resultFiles.map((f) => f.path).sort()).toEqual(["figures/graph.png", "padsync.json"]);

    const picked = pickResult(done)!;
    expect(picked.from).toBe("padsync.json");
    const r = reviewPayload(picked.text, done.resultFiles);
    expect(r.errors).toEqual([]);
    expect(r.payload!.title).toBe("From 01-lecture-9.pdf,02-tiny.pdf");
    // Every byte arrived: the agent saw the full file, in the right order.
    expect(r.payload!.sections[0].blocks[0]).toMatchObject({ text: `Bytes: {{${bigPdf.length}}} starting %PDF-` });
    expect(r.payload!.sections[0].blocks[1]).toMatchObject({ src: PNG_DATA_URL });
    expect(await leftovers()).toEqual([]);
    expect(Number((await sql.query<{ n: number }>(`select count(*)::int as n from job_inputs`))[0].n)).toBe(0);
  });

  it("removes the temp dir and reports the error when the agent fails", async () => {
    await startBridge();
    const { jobId } = await sendImport({ config: { ...DEFAULT_CONFIG, request: "FAIL" }, attachments: [lecture("a.pdf", Buffer.from("%PDF"))], fetch: pageFetch });
    const j = await waitFor(() => job(jobId), (x) => x.status === "error");
    expect(j.error).toMatch(/exited with code 3/);
    expect(j.resultFiles).toEqual([]);
    await waitFor(leftovers, (l) => l.length === 0, 5000);
  });

  it("removes the temp dir when the user cancels a running import", async () => {
    await startBridge();
    const { jobId } = await sendImport({ config: { ...DEFAULT_CONFIG, request: "HANG" }, attachments: [lecture("a.pdf", Buffer.from("%PDF"))], fetch: pageFetch });
    await waitFor(() => job(jobId), (x) => x.status === "running");
    await waitFor(async () => {
      const dirs = await leftovers();
      return dirs.length === 1 && (await readdir(join(jobTmp, dirs[0], "out")).catch((): string[] => [])).includes("partial.txt");
    }, Boolean);
    await cancelRoute(req(`/api/jobs/${jobId}/cancel`, { method: "POST", session }), params({ id: jobId }));
    await waitFor(async () => logs, (l) => l.includes("cancelled by user"));
    expect((await job(jobId)).status).toBe("cancelled");
    await waitFor(leftovers, (l) => l.length === 0, 8000);
  });
});
