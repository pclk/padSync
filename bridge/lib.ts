// padSync bridge internals. Pure helpers plus the agent runner; the CLI lives in padsync-bridge.ts.
// Runs on Node >= 22.18 with native TypeScript type stripping (no build step), so this file uses
// only erasable syntax.

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Agent = "claude" | "codex";
export const AGENTS: Agent[] = ["claude", "codex"];
/** Server-side cap on a job's answer (src/server/jobs.ts MAX_OUTPUT). */
export const MAX_OUTPUT = 200_000;

/** Per-question agent settings chosen in padSync (src/server/jobs.ts jobOptionsSchema). */
export interface JobOptions {
  model?: string;
  effort?: string;
  webSearch?: boolean;
}

export interface ClaimedJob {
  id: string;
  notebookId: string;
  sectionId: string | null;
  agent: Agent;
  question: string;
  options?: JobOptions;
  context: string;
  image: string | null;
}

export interface BridgeConfig {
  server: string;
  token: string;
  agents?: Agent[];
  claudeBin?: string;
  codexBin?: string;
}

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------
// Config: ~/.config/padsync/bridge.json, readable only by the user. Env vars override the file.

export function configPath(env: Env = process.env) {
  return env.PADSYNC_BRIDGE_CONFIG ?? join(homedir(), ".config", "padsync", "bridge.json");
}

export async function loadConfig(env: Env = process.env): Promise<BridgeConfig | null> {
  let file: Partial<BridgeConfig> = {};
  try {
    file = JSON.parse(await readFile(configPath(env), "utf8"));
  } catch {}
  // Empty env vars count as unset (launchd and shells often export them blank).
  const server = env.PADSYNC_SERVER || file.server;
  const token = env.PADSYNC_TOKEN || file.token;
  if (!server || !token) return null;
  return { ...file, server: normalizeServer(server), token };
}

export async function saveConfig(cfg: BridgeConfig, env: Env = process.env) {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode only applies when creating the file
}

export function normalizeServer(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
    throw new Error("server must use https (http is allowed only for localhost)");
  }
  return u.origin;
}

export function maskToken(token: string) {
  return token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : "****";
}

// ---------------------------------------------------------------------------------------------
// Job inputs

export function decodePngDataUrl(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/);
  if (!m) throw new Error("job image is not a base64 PNG data URL");
  return Buffer.from(m[1], "base64");
}

export function buildAgentPrompt(job: Pick<ClaimedJob, "question" | "image" | "context">) {
  const files = [
    job.image ? "- `section.png`: a render of the section, the printed question plus my handwriting." : null,
    job.context ? "- `context.md`: the question's source text, my typed notes, and possibly a reference solution I have NOT seen." : null,
  ].filter(Boolean);
  return [
    "You are helping me (a university student) with work I wrote by hand on my iPad in padSync.",
    files.length ? `Files in the current directory:\n${files.join("\n")}\nRead them before answering.` : "",
    `My question:\n${job.question}`,
    [
      "Guidelines:",
      "- Answer the question directly and refer to specific lines of my working.",
      "- If a reference solution is provided, use it to check me, but do not reveal it in full unless I ask for the solution. Point to the first mistake and give a hint instead.",
      "- Format with Markdown; write maths in LaTeX using $...$ and $$...$$.",
      "- Do not create or modify any files.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Agent output parsing. Both CLIs emit one JSON object per line.

export interface AgentUpdate {
  /** Text to append to the visible answer. */
  text?: string;
  /** Authoritative final answer (replaces streamed text). */
  final?: string;
  /** Fatal error reported by the agent. */
  error?: string;
}

/** `claude -p --output-format stream-json --verbose` */
export function parseClaudeLine(line: string): AgentUpdate | null {
  const ev = safeJson(line);
  if (!ev) return null;
  if (ev.type === "assistant") {
    const parts = (ev.message?.content ?? []).filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "");
    const text = parts.join("");
    return text ? { text } : null;
  }
  if (ev.type === "result") {
    if (ev.is_error || (typeof ev.subtype === "string" && ev.subtype !== "success")) {
      return { error: typeof ev.result === "string" && ev.result ? ev.result : `Claude Code stopped: ${ev.subtype ?? "error"}` };
    }
    return typeof ev.result === "string" ? { final: ev.result } : null;
  }
  return null;
}

/** `codex exec --json` */
export function parseCodexLine(line: string): AgentUpdate | null {
  const ev = safeJson(line);
  if (!ev) return null;
  if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
    return { text: ev.item.text };
  }
  // item.completed with item.type "error" is a non-fatal warning (e.g. config notices).
  if (ev.type === "turn.failed") return { error: ev.error?.message ?? "Codex turn failed" };
  if (ev.type === "error") return { error: ev.message ?? "Codex error" };
  return null;
}

function safeJson(line: string) {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Running an agent

export interface AgentCommand {
  bin: string;
  args: string[];
  parse: (line: string) => AgentUpdate | null;
  /** File the agent writes its final message to, if any (relative to cwd). */
  finalFile?: string;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
const EFFORTS: Record<Agent, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

/** Drops anything the agent's CLI would not accept, so a bad option falls back to its default. */
export function cleanOptions(agent: Agent, o: JobOptions = {}): JobOptions {
  const effort = agent === "claude" && o.effort === "ultra" ? "max" : o.effort;
  return {
    model: typeof o.model === "string" && MODEL_RE.test(o.model) ? o.model : undefined,
    effort: effort && EFFORTS[agent].includes(effort) ? effort : undefined,
    webSearch: o.webSearch === true,
  };
}

export function agentCommand(agent: Agent, cfg: Pick<BridgeConfig, "claudeBin" | "codexBin">, hasImage: boolean, options?: JobOptions): AgentCommand {
  const o = cleanOptions(agent, options);
  if (agent === "claude") {
    const web = o.webSearch ? ["WebSearch", "WebFetch"] : [];
    const denied = ["Bash", "Edit", "Write", "NotebookEdit", ...(o.webSearch ? [] : ["WebFetch", "WebSearch"])];
    return {
      bin: cfg.claudeBin ?? "claude",
      // Restrict built-in tools and ignore ambient MCP servers. Prompt arrives on stdin.
      args: [
        "-p", "--output-format", "stream-json", "--verbose",
        ...(o.model ? ["--model", o.model] : []),
        ...(o.effort ? ["--effort", o.effort] : []),
        "--tools", ["Read", ...web].join(","), "--strict-mcp-config",
        "--allowedTools", "Read", ...web,
        "--disallowedTools", ...denied,
      ],
      parse: parseClaudeLine,
    };
  }
  // --search is a top-level codex flag, so it goes before `exec`.
  const args = [...(o.webSearch ? ["--search"] : []), "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message", "final.md"];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  if (hasImage) args.push("--image", "section.png");
  return { bin: cfg.codexBin ?? "codex", args, parse: parseCodexLine, finalFile: "final.md" };
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  command: AgentCommand;
  timeoutMs: number;
  onText: (fullText: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  status: "done" | "error" | "cancelled";
  output: string;
  error?: string;
}

/** The agent inherits the user's environment minus padSync's own credentials. */
export function agentEnv(env: Env = process.env): Env {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("PADSYNC_")));
}

export function runAgent(opts: RunOptions): Promise<RunResult> {
  const { command } = opts;
  return new Promise((resolve) => {
    const child = spawn(command.bin, command.args, { cwd: opts.cwd, env: (opts.env ?? agentEnv()) as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let streamed = "";
    let final: string | undefined;
    let error: string | undefined;
    let stderr = "";
    let buffer = "";
    let settled = false;
    let stopReason: "cancelled" | "timeout" | null = null;

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const stop = (reason: "cancelled" | "timeout") => {
      if (stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    };
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    if (opts.signal?.aborted) stop("cancelled");
    opts.signal?.addEventListener("abort", onAbort);

    const handle = (line: string) => {
      const u = command.parse(line);
      if (!u) return;
      if (u.text) {
        streamed = streamed ? `${streamed}\n\n${u.text}` : u.text;
        opts.onText(streamed);
      }
      if (u.final !== undefined) final = u.final;
      if (u.error) error = u.error;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on("error", (e) => finish({ status: "error", output: streamed, error: `could not start ${command.bin}: ${e.message}` }));
    child.on("close", async (code) => {
      if (buffer) handle(buffer);
      if (stopReason === "cancelled") return finish({ status: "cancelled", output: streamed });
      if (stopReason === "timeout") return finish({ status: "error", output: streamed, error: `timed out after ${Math.round(opts.timeoutMs / 1000)}s` });
      if (command.finalFile) {
        const fromFile = await readFile(join(opts.cwd, command.finalFile), "utf8").catch(() => "");
        if (fromFile.trim()) final = fromFile.trim();
      }
      const output = final ?? streamed;
      if (error || code !== 0) {
        return finish({ status: "error", output, error: error ?? `${command.bin} exited with code ${code}: ${lastLine(stderr)}` });
      }
      finish({ status: "done", output });
    });

    child.stdin.on("error", () => {}); // agent may exit before reading stdin
    child.stdin.end(opts.prompt);
  });
}

function lastLine(s: string) {
  return s.trim().split("\n").slice(-3).join(" ").slice(0, 500) || "no output";
}

// ---------------------------------------------------------------------------------------------
// launchd (macOS): keep the bridge running in the background and across logins.

export const LAUNCHD_LABEL = "sg.padsync.bridge";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(opts: { node: string; script: string; path: string; logFile: string }) {
  const args = [opts.node, opts.script, "run"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(opts.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.logFile)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------------------------
// Server API

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BridgeApi {
  server: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(cfg: Pick<BridgeConfig, "server" | "token">, fetchImpl: typeof fetch = fetch) {
    this.server = cfg.server;
    this.token = cfg.token;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.server + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error", // never forward the token to another host
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  whoami() {
    return this.call<{ device: { id: string; name: string } }>("GET", "/api/bridge/whoami");
  }

  claim(agents: Agent[], info: { hostname?: string; version?: string }) {
    return this.call<{ job: ClaimedJob | null }>("POST", "/api/bridge/claim", { agents, info });
  }

  update(jobId: string, u: { output?: string; status?: "done" | "error"; error?: string }) {
    return this.call<{ status: string; cancelled: boolean }>("POST", `/api/bridge/jobs/${encodeURIComponent(jobId)}`, { ...u, ...(u.output === undefined ? {} : { output: u.output.slice(0, MAX_OUTPUT) }) });
  }
}
