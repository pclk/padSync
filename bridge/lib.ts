// padSync bridge internals. Pure helpers plus the agent runner; the CLI lives in padsync-bridge.ts.
// Runs on Node >= 22.18 with native TypeScript type stripping (no build step), so this file uses
// only erasable syntax.

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export type Agent = "claude" | "codex";
export const AGENTS: Agent[] = ["claude", "codex"];
/** Server-side cap on a job's answer (src/server/jobs.ts MAX_OUTPUT). */
export const MAX_OUTPUT = 200_000;

/** Per-question agent settings chosen in padSync (src/server/jobs.ts jobOptionsSchema). */
export interface JobOptions {
  model?: string;
  effort?: string;
  webSearch?: boolean;
  /** The agent may write changed copies into out/. */
  allowEdits?: boolean;
  /** Claude also gets Bash, in Claude Code's sandbox. */
  allowCode?: boolean;
}

/** A file of the job's context bundle (src/lib/context.ts), or one the agent wrote to out/. */
export interface JobFile {
  path: string;
  mime: string;
  text?: string;
  base64?: string;
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
  /** When present, the job's inputs; context and image are then ignored. */
  files?: JobFile[];
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

// Inputs never go into the prompt itself: the bridge writes them to a private per-job directory
// (the agent's cwd) and the prompt only names their absolute paths. File names are fixed, so
// nothing from the job ever becomes part of a path.

export const JOB_DIR_PREFIX = "padsync-job-";
export const IMAGE_FILE = "section.png";
export const CONTEXT_FILE = "context.md";

export const OUT_DIR = "out";
/** Same rule as the server (src/lib/context.ts BUNDLE_PATH_RE): one optional folder, no leading dot. */
export const BUNDLE_PATH_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** What may come back from out/ (src/server/jobs.ts resultFilesSchema). */
export const MAX_RESULT_FILES = 20;
export const MAX_RESULT_BYTES = 2_000_000;

export interface JobDir {
  dir: string;
  /** Absolute paths of the inputs that exist for this job. */
  image?: string;
  context?: string;
  /** Bundle jobs: the input files (relative to dir) and the empty folder for changed copies. */
  files?: { path: string; mime: string }[];
  out?: string;
}

/** Resolves a bundle path inside `dir`, or throws: nothing from a job may land outside it. */
export function safeJoin(dir: string, path: string) {
  if (!BUNDLE_PATH_RE.test(path)) throw new Error(`unsafe file name in job: ${JSON.stringify(path.slice(0, 120))}`);
  const full = resolve(dir, path);
  const rel = relative(dir, full);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) throw new Error(`file escapes the job folder: ${path}`);
  return full;
}

/** Creates a fresh 0700 directory under `root` holding the job's inputs. Removes it again on failure. */
export async function prepareJobDir(job: Pick<ClaimedJob, "image" | "context" | "files">, root: string = tmpdir()): Promise<JobDir> {
  // realpath: macOS tmpdir() is behind the /var -> /private/var symlink; give agents the real path.
  const dir = await realpath(await mkdtemp(join(root, JOB_DIR_PREFIX)));
  try {
    const out: JobDir = { dir };
    if (job.files?.length) {
      out.files = [];
      for (const f of job.files) {
        if (f.path.split("/")[0] === OUT_DIR) throw new Error("job inputs may not be in out/");
        const full = safeJoin(dir, f.path);
        await mkdir(dirname(full), { recursive: true, mode: 0o700 });
        const body = f.base64 !== undefined ? Buffer.from(f.base64, "base64") : (f.text ?? "");
        await writeFile(full, body, { mode: 0o600, flag: "wx" }); // wx: never overwrite or follow a link
        out.files.push({ path: f.path, mime: f.mime });
      }
      out.out = join(dir, OUT_DIR);
      await mkdir(out.out, { mode: 0o700 });
      return out;
    }
    if (job.image) {
      out.image = join(dir, IMAGE_FILE);
      await writeFile(out.image, decodePngDataUrl(job.image), { mode: 0o600, flag: "wx" });
    }
    if (job.context) {
      out.context = join(dir, CONTEXT_FILE);
      await writeFile(out.context, job.context, { mode: 0o600, flag: "wx" });
    }
    return out;
  } catch (e) {
    await removeJobDir(dir);
    throw e;
  }
}

/** Best-effort recursive delete; never throws (a failed cleanup must not take the bridge down). */
export async function removeJobDir(dir: string): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` with the job's inputs on disk and always removes them afterwards, even if `fn` throws. */
export async function withJobDir<T>(job: Pick<ClaimedJob, "image" | "context" | "files">, fn: (d: JobDir) => Promise<T>, root?: string): Promise<T> {
  const d = await prepareJobDir(job, root);
  try {
    return await fn(d);
  } finally {
    await removeJobDir(d.dir);
  }
}

/**
 * Deletes job directories left behind by a bridge that was killed mid-job (SIGKILL, crash, power
 * loss). Only directories older than `maxAgeMs` go, so a second bridge's live job is never touched.
 */
export async function sweepStaleJobDirs(maxAgeMs: number, root: string = tmpdir(), now = Date.now()): Promise<number> {
  let removed = 0;
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(JOB_DIR_PREFIX)) continue;
    const path = join(root, name);
    const st = await lstat(path).catch(() => null);
    if (!st?.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
    if (await removeJobDir(path)) removed++;
  }
  return removed;
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const isBinary = (mime: string) => mime.startsWith("image/") || mime === "application/pdf";

export interface CollectedFiles {
  files: JobFile[];
  /** Files left behind, with why. */
  skipped: string[];
}

/**
 * Reads what the agent wrote to out/: regular files only (symlinks are not followed), at most one
 * folder deep, safe names, text that is valid UTF-8, within the count and size caps.
 */
export async function collectOutFiles(outDir: string): Promise<CollectedFiles> {
  const files: JobFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const visit = async (rel: string, depth: number) => {
    const names = (await readdir(join(outDir, rel)).catch(() => [] as string[])).sort();
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(outDir, path)).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        if (depth === 0 && BUNDLE_PATH_RE.test(name)) await visit(path, 1);
        else skipped.push(`${path}/ (folders can be one level deep)`);
        continue;
      }
      if (!st.isFile()) {
        skipped.push(`${path} (not a regular file)`);
        continue;
      }
      if (!BUNDLE_PATH_RE.test(path)) {
        skipped.push(`${path} (unsupported file name)`);
        continue;
      }
      if (files.length >= MAX_RESULT_FILES) {
        skipped.push(`${path} (more than ${MAX_RESULT_FILES} files)`);
        continue;
      }
      // Cheap size check before reading: base64 grows by 4/3.
      if (total + st.size > MAX_RESULT_BYTES) {
        skipped.push(`${path} (over the ${MAX_RESULT_BYTES / 1_000_000} MB total)`);
        continue;
      }
      const mime = MIME_BY_EXT[extname(name).toLowerCase()] ?? "text/plain";
      const buf = await readFile(join(outDir, path));
      let file: JobFile;
      if (isBinary(mime)) file = { path, mime, base64: buf.toString("base64") };
      else {
        try {
          file = { path, mime, text: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
        } catch {
          skipped.push(`${path} (binary file)`);
          continue;
        }
      }
      const size = (file.text?.length ?? 0) + (file.base64?.length ?? 0);
      if (total + size > MAX_RESULT_BYTES) {
        skipped.push(`${path} (over the ${MAX_RESULT_BYTES / 1_000_000} MB total)`);
        continue;
      }
      total += size;
      files.push(file);
    }
  };
  await visit("", 0);
  return { files, skipped };
}

/** Images Codex gets attached with --image (it cannot view a file it was only told about). */
export function attachedImages(files: JobDir["files"]): string[] {
  return (files ?? []).filter((f) => f.mime === "image/png" || f.mime === "image/jpeg").map((f) => f.path).slice(0, 8);
}

const FILE_ROLES: [RegExp, string][] = [
  [/^README\.md$/, "what each file is and how to return changes; read it first"],
  [/^notebook\.md$/, "the chosen sections: printed content, my typed notes, and possibly reference solutions I have NOT seen"],
  [/^notebook\.json$/, "the same sections in padSync's format, with ids"],
  [/^selection\.md$/, "the part of the notebook I selected"],
  [/^selection\.png$/, "an image of the selected area, with my handwriting"],
  [/^renders\//, "a render of a section: printed content plus my handwriting"],
  [/^assets\//, "an image embedded in a section"],
];

/** Prompt for a bundle job: names the files by absolute path; never includes their content. */
export function buildBundlePrompt(question: string, d: Pick<JobDir, "dir" | "files" | "out">, agent: Agent, options: JobOptions = {}) {
  const attached = new Set(agent === "codex" ? attachedImages(d.files) : []);
  const list = (d.files ?? []).map((f) => {
    const role = FILE_ROLES.find(([re]) => re.test(f.path))?.[1] ?? "input";
    return "- `" + join(d.dir, f.path) + "`: " + role + (attached.has(f.path) ? " (also attached)" : "");
  });
  const edits = options.allowEdits && d.out;
  return [
    "You are helping me (a university student) with work from my iPad notebook in padSync.",
    `The material is in files in your working directory \`${d.dir}\`:\n${list.join("\n")}\n` +
      "Use your file tools to read what you need before answering. The files are not repeated in this message.",
    `My question:\n${question}`,
    [
      "Guidelines:",
      "- Answer the question directly and refer to specific parts of my work.",
      "- If a reference solution is provided, use it to check me, but do not reveal it in full unless I ask for the solution. Point to the first mistake and give a hint instead.",
      "- Format with Markdown; write maths in LaTeX using $...$ and $$...$$.",
      edits
        ? "- If my request needs changes to the material, do not edit the files in place: write changed copies to `" + d.out + "/` under the same relative path (e.g. `" + d.out + "/notebook.json`, keeping each section's id). Put any other files you make there too, and say in your answer what you wrote. Write nothing outside that folder."
        : "- Do not create or modify any files.",
      options.allowCode && agent === "claude" ? "- You may run code (e.g. to check a calculation) with Bash in this folder." : null,
    ]
      .filter(Boolean)
      .join("\n"),
  ].join("\n\n");
}

export function buildAgentPrompt(question: string, files: Omit<JobDir, "dir">, agent: Agent = "claude") {
  // Codex gets the image attached with --image, so it must not open the file a second time.
  const imageAttached = agent === "codex";
  const lines = [
    files.image
      ? imageAttached
        ? "- The attached image (also at `" + files.image + "`): a render of the section, the printed question plus my handwriting."
        : "- `" + files.image + "`: a render of the section, the printed question plus my handwriting."
      : null,
    files.context ? "- `" + files.context + "`: the question's source text, my typed notes, and possibly a reference solution I have NOT seen." : null,
  ].filter(Boolean);
  const how = imageAttached
    ? files.context
      ? "Read the text file before answering; the image is already attached, so don't open it again."
      : "Look at the attached image before answering."
    : "Open them with your Read tool before answering.";
  return [
    "You are helping me (a university student) with work I wrote by hand on my iPad in padSync.",
    lines.length ? `My work is in these files:\n${lines.join("\n")}\n${how}` : "",
    `My question:\n${question}`,
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
    allowEdits: o.allowEdits === true,
    allowCode: o.allowEdits === true && o.allowCode === true,
  };
}

/** Claude Code's own sandbox for Bash (Seatbelt on macOS): commands can't write outside the cwd. */
export const CLAUDE_SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });

/**
 * `images`: true for a legacy job's section.png, or the relative paths Codex should get attached.
 * Edits stay inside the job folder: Claude via acceptEdits (cwd only), Codex via workspace-write.
 */
export function agentCommand(agent: Agent, cfg: Pick<BridgeConfig, "claudeBin" | "codexBin">, images: boolean | string[], options?: JobOptions): AgentCommand {
  const o = cleanOptions(agent, options);
  if (agent === "claude") {
    const web = o.webSearch ? ["WebSearch", "WebFetch"] : [];
    const edit = o.allowEdits ? ["Write", "Edit"] : [];
    const code = o.allowCode ? ["Bash"] : [];
    const tools = ["Read", ...(o.allowEdits ? ["Glob", "Grep"] : []), ...edit, ...code, ...web];
    // Write/Edit are available but not pre-approved: acceptEdits approves them inside the cwd only,
    // and anything outside would need a prompt, which print mode denies.
    const allowed = tools.filter((t) => !edit.includes(t));
    const denied = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"].filter((t) => !tools.includes(t));
    return {
      bin: cfg.claudeBin ?? "claude",
      // Restrict built-in tools and ignore ambient MCP servers. Prompt arrives on stdin.
      args: [
        "-p", "--output-format", "stream-json", "--verbose",
        ...(o.model ? ["--model", o.model] : []),
        ...(o.effort ? ["--effort", o.effort] : []),
        ...(o.allowEdits ? ["--permission-mode", "acceptEdits"] : []),
        ...(o.allowCode ? ["--settings", CLAUDE_SANDBOX_SETTINGS] : []),
        "--tools", tools.join(","), "--strict-mcp-config",
        "--allowedTools", ...allowed,
        "--disallowedTools", ...denied,
      ],
      parse: parseClaudeLine,
    };
  }
  // --search is a top-level codex flag, so it goes before `exec`.
  const sandbox = o.allowEdits ? "workspace-write" : "read-only";
  const args = [...(o.webSearch ? ["--search"] : []), "exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "--output-last-message", "final.md"];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
  for (const img of images === true ? [IMAGE_FILE] : images || []) args.push("--image", img);
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

  private async call<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const res = await this.fetchImpl(this.server + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
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

  update(jobId: string, u: { output?: string; status?: "done" | "error"; error?: string; files?: JobFile[] }, opts?: { signal?: AbortSignal; timeoutMs?: number }) {
    return this.call<{ status: string; cancelled: boolean }>("POST", `/api/bridge/jobs/${encodeURIComponent(jobId)}`, { ...u, ...(u.output === undefined ? {} : { output: u.output.slice(0, MAX_OUTPUT) }) }, opts);
  }
}
