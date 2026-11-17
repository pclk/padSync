import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BridgeApi,
  agentCommand,
  buildAgentPrompt,
  decodePngDataUrl,
  launchdPlist,
  loadConfig,
  maskToken,
  normalizeServer,
  parseClaudeLine,
  parseCodexLine,
  runAgent,
  saveConfig,
  type AgentCommand,
} from "../bridge/lib.ts";
import { PNG_DATA_URL } from "./helpers/env";

const fixture = async (name: string) => (await readFile(join(__dirname, "fixtures", name), "utf8")).trim().split("\n");

describe("parsing real agent output", () => {
  it("claude stream-json: streams assistant text and takes the result as final", async () => {
    const updates = (await fixture("claude-stream.jsonl")).map(parseClaudeLine).filter(Boolean);
    expect(updates).toEqual([{ text: "pong" }, { final: "pong" }]);
  });

  it("claude: error results become errors", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual({ error: "Claude Code stopped: error_max_turns" });
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" }))).toEqual({ error: "Invalid API key" });
  });

  it("claude: ignores tool_use blocks and non-JSON lines", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
    expect(parseClaudeLine("{broken")).toBeNull();
  });

  it("codex exec --json: agent messages stream; config warnings are not fatal", async () => {
    const updates = (await fixture("codex-exec.jsonl")).map(parseCodexLine).filter(Boolean);
    expect(updates).toEqual([{ text: "pong" }]);
  });

  it("codex: turn.failed and top-level errors are fatal", () => {
    expect(parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "quota" } }))).toEqual({ error: "quota" });
    expect(parseCodexLine(JSON.stringify({ type: "error", message: "boom" }))).toEqual({ error: "boom" });
  });
});

describe("agent commands are read-only", () => {
  it("claude: only Read is allowed, write/exec tools are denied, prompt via stdin", () => {
    const c = agentCommand("claude", {}, true);
    expect(c.bin).toBe("claude");
    expect(c.args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(c.args).toContain("--allowedTools");
    const denied = c.args.slice(c.args.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    expect(c.args).not.toContain("--dangerously-skip-permissions");
  });

  it("codex: read-only sandbox, final message to file, image only when present", () => {
    const withImage = agentCommand("codex", { codexBin: "/opt/codex" }, true);
    expect(withImage.bin).toBe("/opt/codex");
    expect(withImage.args).toEqual(expect.arrayContaining(["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"]));
    expect(withImage.args.slice(-2)).toEqual(["--image", "section.png"]);
    expect(withImage.finalFile).toBe("final.md");
    expect(agentCommand("codex", {}, false).args).not.toContain("--image");
    expect(withImage.args.join(" ")).not.toMatch(/dangerously|full-auto|workspace-write/);
  });
});

describe("prompt and inputs", () => {
  it("mentions only the files that exist, by absolute path", () => {
    const both = buildAgentPrompt("Q?", { image: "/t/padsync-job-1/section.png", context: "/t/padsync-job-1/context.md" });
    expect(both).toContain("`/t/padsync-job-1/section.png`");
    expect(both).toContain("`/t/padsync-job-1/context.md`");
    const none = buildAgentPrompt("Q?", {});
    expect(none).not.toContain("section.png");
    expect(none).not.toContain("context.md");
    expect(none).toContain("Q?");
  });

  it("tells the agent not to reveal the solution or modify files", () => {
    const p = buildAgentPrompt("Q?", { context: "/t/context.md" });
    expect(p).toMatch(/do not reveal it in full/i);
    expect(p).toMatch(/do not create or modify any files/i);
  });

  it("decodes PNG data URLs and rejects anything else", () => {
    expect(decodePngDataUrl(PNG_DATA_URL).subarray(1, 4).toString()).toBe("PNG");
    expect(() => decodePngDataUrl("data:image/svg+xml;base64,AAAA")).toThrow();
    expect(() => decodePngDataUrl("https://x/y.png")).toThrow();
  });
});

describe("config", () => {
  it("requires https except for localhost", () => {
    expect(normalizeServer("https://pad-sync.vercel.app/settings")).toBe("https://pad-sync.vercel.app");
    expect(normalizeServer("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => normalizeServer("http://pad-sync.vercel.app")).toThrow(/https/);
  });

  it("masks tokens", () => {
    expect(maskToken("psd_abcdefghijklmnopqrstuvwxyz")).toBe("psd_abcd…wxyz");
    expect(maskToken("short")).toBe("****");
  });

  it("saves the config readable only by the user, and env overrides it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "padsync-cfg-"));
    const env = { PADSYNC_BRIDGE_CONFIG: join(dir, "nested", "bridge.json") };
    await saveConfig({ server: "https://a.test", token: "psd_file" }, env);
    expect((await stat(env.PADSYNC_BRIDGE_CONFIG)).mode & 0o777).toBe(0o600);
    expect(await loadConfig(env)).toMatchObject({ server: "https://a.test", token: "psd_file" });
    expect(await loadConfig({ ...env, PADSYNC_TOKEN: "psd_env" })).toMatchObject({ token: "psd_env" });
    expect(await loadConfig({ ...env, PADSYNC_TOKEN: "", PADSYNC_SERVER: "" })).toMatchObject({ server: "https://a.test", token: "psd_file" });
    expect(await loadConfig({ PADSYNC_BRIDGE_CONFIG: join(dir, "missing.json") })).toBeNull();
  });

  it("escapes paths in the launchd plist", () => {
    const plist = launchdPlist({ node: "/usr/bin/node", script: "/Users/a&b/<x>/bridge.ts", path: "/bin", logFile: "/tmp/log" });
    expect(plist).toContain("/Users/a&amp;b/&lt;x&gt;/bridge.ts");
    expect(plist).not.toContain("a&b");
    expect(plist).toContain("<string>run</string>");
  });
});

describe("BridgeApi", () => {
  it("sends the bearer token and refuses redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ job: null }), { status: 200 }));
    const api = new BridgeApi({ server: "https://pad.test", token: "psd_secret" }, fetchImpl as unknown as typeof fetch);
    await api.claim(["claude"], { hostname: "h" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pad.test/api/bridge/claim");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer psd_secret");
    expect(init.redirect).toBe("error");
  });

  it("surfaces HTTP status on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid or revoked device token" }), { status: 401 }));
    const api = new BridgeApi({ server: "https://pad.test", token: "t" }, fetchImpl as unknown as typeof fetch);
    await expect(api.whoami()).rejects.toMatchObject({ status: 401, message: "invalid or revoked device token" });
  });
});

describe("runAgent (with fake agent processes)", () => {
  async function fake(script: string, parse = parseClaudeLine, finalFile?: string): Promise<{ cwd: string; command: AgentCommand }> {
    const cwd = await mkdtemp(join(tmpdir(), "padsync-run-"));
    await writeFile(join(cwd, "agent.mjs"), script);
    return { cwd, command: { bin: process.execPath, args: ["agent.mjs"], parse, finalFile } };
  }
  const line = (o: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(o) + "\n")});`;

  it("passes the prompt on stdin, streams text, returns the final result", async () => {
    const { cwd, command } = await fake(`
      let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
        ${line({ type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } })}
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "echo:" + input }) + "\\n");
      });`);
    const seen: string[] = [];
    const r = await runAgent({ cwd, prompt: "hello", command, timeoutMs: 10_000, onText: (t) => seen.push(t) });
    expect(seen).toEqual(["thinking"]);
    expect(r).toEqual({ status: "done", output: "echo:hello" });
  });

  it("reports a non-zero exit with stderr", async () => {
    const { cwd, command } = await fake(`process.stderr.write("not logged in\\n"); process.exit(3);`);
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 10_000, onText: () => {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/code 3.*not logged in/);
  });

  it("reports a missing binary", async () => {
    const r = await runAgent({ cwd: tmpdir(), prompt: "", command: { bin: "/nonexistent/agent", args: [], parse: parseClaudeLine }, timeoutMs: 5000, onText: () => {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/could not start/);
  });

  it("stops the agent when cancelled", async () => {
    const { cwd, command } = await fake(`${line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })} setInterval(() => {}, 1000);`);
    const ac = new AbortController();
    const started = Date.now();
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 30_000, signal: ac.signal, onText: () => ac.abort() });
    expect(r.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("times out a hung agent", async () => {
    const { cwd, command } = await fake(`setInterval(() => {}, 1000);`);
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 300, onText: () => {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/timed out/);
  });

  it("prefers the final-message file (codex -o) over streamed text", async () => {
    const { cwd, command } = await fake(
      `import { writeFileSync } from "node:fs"; ${line({ type: "item.completed", item: { type: "agent_message", text: "streamed" } })} writeFileSync("final.md", "from file\\n");`,
      parseCodexLine,
      "final.md",
    );
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 10_000, onText: () => {} });
    expect(r).toEqual({ status: "done", output: "from file" });
  });

  it("treats an agent-reported error as failure even on exit 0", async () => {
    const { cwd, command } = await fake(line({ type: "turn.failed", error: { message: "usage limit" } }), parseCodexLine);
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 10_000, onText: () => {} });
    expect(r).toMatchObject({ status: "error", error: "usage limit" });
  });
});
