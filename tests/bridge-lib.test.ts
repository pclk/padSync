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
    expect(updates).toEqual([{ text: "pong" }, { final: "pong", complete: true }]);
  });

  it("claude --include-partial-messages: text deltas stream; other stream events are ignored", () => {
    const ev = (event: unknown) => JSON.stringify({ type: "stream_event", event });
    expect(parseClaudeLine(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } }))).toEqual({ delta: "po" });
    expect(parseClaudeLine(ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{" } }))).toBeNull();
    expect(parseClaudeLine(ev({ type: "message_start", message: {} }))).toBeNull();
  });

  it("claude: error results become errors", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual({ error: "Claude Code stopped: error_max_turns" });
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" }))).toEqual({ error: "Invalid API key" });
  });

  it("claude: a tool_use block marks a tool call; non-JSON lines are ignored", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }))).toEqual({ tool: true });
    expect(parseClaudeLine("not json")).toBeNull();
    expect(parseClaudeLine("{broken")).toBeNull();
  });

  it("codex exec --json: agent messages stream; config warnings are not fatal", async () => {
    const updates = (await fixture("codex-exec.jsonl")).map(parseCodexLine).filter(Boolean);
    expect(updates).toEqual([{ text: "pong" }, { complete: true }]);
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

  it("keeps thinking apart from the answer and moves a preamble before a tool into it", async () => {
    const ev = (event: unknown) => line({ type: "stream_event", event });
    const { cwd, command } = await fake(`
      ${ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking " } })}
      ${ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the sign." } })}
      ${line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Checking the sign." }] } })}
      ${ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me read your notes." } })}
      ${line({ type: "assistant", message: { content: [{ type: "text", text: "Let me read your notes." }] } })}
      ${ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "Read" } })}
      ${ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is 9/2." } })}
      ${line({ type: "result", subtype: "success", is_error: false, result: "It is 9/2." })}`);
    const texts: string[] = [];
    const thoughts: string[] = [];
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 10_000, onText: (t) => texts.push(t), onThinking: (t) => thoughts.push(t) });
    expect(thoughts).toEqual(["Checking ", "Checking the sign.", "Checking the sign.", "Checking the sign.\n\nLet me read your notes."]);
    expect(texts).toEqual(["Let me read your notes.", "Let me read your notes.", "", "It is 9/2."]);
    expect(r).toEqual({ status: "done", output: "It is 9/2.", thinking: "Checking the sign.\n\nLet me read your notes." });
  });

  it("codex: reasoning summaries are thinking, tool items mark tool calls", () => {
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "**Verifying the count**" } }))).toEqual({ thinking: "**Verifying the count**" });
    expect(parseCodexLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "cat notebook.md" } }))).toEqual({ tool: true });
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "" } }))).toBeNull();
  });

  it("asks for thinking summaries: Claude only when its CLI has the flag, Codex always", () => {
    const flag = (c: AgentCommand) => c.args.join(" ");
    expect(flag(agentCommand("claude", { claudeThinking: true }, false))).toContain("--thinking-display summarized");
    expect(flag(agentCommand("claude", {}, false))).not.toContain("--thinking-display");
    expect(flag(agentCommand("codex", {}, false))).toContain('model_reasoning_summary="detailed" -c hide_agent_reasoning=false');
  });

  it("streams partial text and finishes on the result, before the CLI exits", async () => {
    const delta = (text: string) => line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    const { cwd, command } = await fake(`
      ${delta("Let me ")}${delta("check.")}
      ${line({ type: "assistant", message: { content: [{ type: "text", text: "Let me check." }] } })}
      ${delta("The answer")}
      ${line({ type: "system", subtype: "init", session_id: "s1" })}
      ${line({ type: "result", subtype: "success", is_error: false, result: "The answer is 9/2." })}
      setTimeout(() => {}, 20000); // still saving its session`);
    const seen: string[] = [];
    const started = Date.now();
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 30_000, onText: (t) => seen.push(t) });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(seen).toEqual(["Let me ", "Let me check.", "Let me check.", "Let me check.\n\nThe answer"]);
    expect(r).toEqual({ status: "done", output: "The answer is 9/2.", sessionId: "s1" });
  });

  it("finishes a Codex turn on turn.completed with its last message", async () => {
    const { cwd, command } = await fake(`
      ${line({ type: "item.completed", item: { type: "agent_message", text: "Checking." } })}
      ${line({ type: "item.completed", item: { type: "agent_message", text: "It is 9/2." } })}
      ${line({ type: "turn.completed" })}
      setTimeout(() => {}, 20000);`, parseCodexLine, "final.md");
    const started = Date.now();
    const r = await runAgent({ cwd, prompt: "", command, timeoutMs: 30_000, onText: () => {} });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toEqual({ status: "done", output: "It is 9/2." });
  });

  it("sends inline images as one stream-json message, and names any too big to attach", async () => {
    const { agentInput, MAX_INLINE_IMAGE } = await import("../bridge/lib");
    const cwd = await mkdtemp(join(tmpdir(), "padsync-in-"));
    await writeFile(join(cwd, "a.png"), Buffer.from("png"));
    await writeFile(join(cwd, "big.jpg"), Buffer.alloc(MAX_INLINE_IMAGE + 1));
    expect(await agentInput(cwd, "plain")).toBe("plain");
    const msg = JSON.parse(await agentInput(cwd, "Q", ["a.png", "big.jpg"]));
    expect(msg.message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("png").toString("base64") } });
    expect(msg.message.content).toHaveLength(2);
    expect(msg.message.content[1].text).toMatch(/^Q\n\n\(Not attached after all.*big\.jpg/);
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

describe("answer formatting guide", () => {
  it("teaches colour in every prompt and interactive pages in the chat's", async () => {
    const { buildAgentPrompt, buildBundlePrompt, COLOR_GUIDE, INTERACTIVE_GUIDE } = await import("../bridge/lib");
    const chat = buildBundlePrompt("Why?", { dir: "/tmp/job", files: [], out: undefined }, "claude");
    expect(chat).toContain(COLOR_GUIDE);
    expect(chat).toContain(INTERACTIVE_GUIDE);
    // The syntax taught is the syntax the chat renders (src/lib/markdown.ts).
    expect(COLOR_GUIDE).toContain("[text]{.blue}");
    expect(COLOR_GUIDE).toContain(":::key");
    expect(COLOR_GUIDE).toContain("\\red{");
    expect(INTERACTIVE_GUIDE).toContain("```interactive");
    const ask = buildAgentPrompt("Q?", {});
    expect(ask).toContain(COLOR_GUIDE);
    expect(ask).not.toContain(INTERACTIVE_GUIDE);
  });
});
