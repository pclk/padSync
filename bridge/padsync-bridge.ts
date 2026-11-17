#!/usr/bin/env node
// padSync bridge: runs on your Mac, picks up "Ask AI" jobs from padSync and answers them with
// your local Claude Code or Codex (your subscription, not API credits).
//
//   pbpaste | node bridge/padsync-bridge.ts setup --server https://p.siew.dev
//   node bridge/padsync-bridge.ts status
//   node bridge/padsync-bridge.ts run          # foreground
//   node bridge/padsync-bridge.ts install      # background via launchd, starts at login
//   node bridge/padsync-bridge.ts uninstall

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  ApiError,
  BridgeApi,
  LAUNCHD_LABEL,
  agentCommand,
  buildAgentPrompt,
  cleanOptions,
  configPath,
  decodePngDataUrl,
  launchdPlist,
  loadConfig,
  maskToken,
  normalizeServer,
  runAgent,
  saveConfig,
  type Agent,
  type BridgeConfig,
  type ClaimedJob,
} from "./lib.ts";

const VERSION = "0.1.0";
const POLL_MS = 3000;
const MAX_BACKOFF_MS = 60_000;
const FLUSH_MS = 1000;
// Even with no new text, check in this often: it is how a silent agent learns it was cancelled,
// and it keeps the job from looking stale (and being reclaimed) during long thinking.
const HEARTBEAT_MS = 5000;
const JOB_TIMEOUT_MS = 15 * 60_000;
const TOKEN_RE = /^psd_[A-Za-z0-9_-]{43}$/;

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write("Paste the device token, then press Enter: ");
  }
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (process.stdin.isTTY && data.includes("\n")) break;
  }
  return data.trim();
}

function flag(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function available(agent: Agent, cfg: BridgeConfig) {
  const bin = agent === "claude" ? (cfg.claudeBin ?? "claude") : (cfg.codexBin ?? "codex");
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

async function setup() {
  const server = flag("--server");
  if (!server) throw new Error("usage: <token on stdin> | padsync-bridge setup --server https://your-padsync.vercel.app");
  // The token is read from stdin, never argv, so it doesn't land in shell history or `ps`.
  const token = await readStdin();
  if (!TOKEN_RE.test(token)) throw new Error("that doesn't look like a padSync device token (psd_…)");
  const cfg: BridgeConfig = { ...((await loadConfig()) ?? {}), server: normalizeServer(server), token };
  const me = await new BridgeApi(cfg).whoami();
  await saveConfig(cfg);
  console.log(`Saved ${configPath()} (mode 600). Token works: device "${me.device.name}".`);
}

async function status() {
  const cfg = await loadConfig();
  if (!cfg) return console.log("Not set up. Run: pbpaste | node bridge/padsync-bridge.ts setup --server <url>");
  console.log(`server  ${cfg.server}\ntoken   ${maskToken(cfg.token)}\nconfig  ${configPath()}`);
  for (const a of cfg.agents ?? AGENTS) console.log(`${a.padEnd(7)} ${available(a, cfg) ?? "not found"}`);
  try {
    const me = await new BridgeApi(cfg).whoami();
    console.log(`auth    ok (device "${me.device.name}")`);
  } catch (e) {
    console.log(`auth    FAILED: ${(e as Error).message}`);
  }
}

async function handleJob(api: BridgeApi, cfg: BridgeConfig, job: ClaimedJob) {
  const o = cleanOptions(job.agent, job.options);
  const how = [o.model, o.effort && `effort ${o.effort}`, o.webSearch && "web search"].filter(Boolean).join(", ");
  log(`job ${job.id} (${job.agent}${how ? `: ${how}` : ""}): ${job.question.slice(0, 80)}`);
  const dir = await mkdtemp(join(tmpdir(), "padsync-job-"));
  const abort = new AbortController();
  let latest = "";
  let sent = "";
  let lastContact = Date.now();
  let flushing: Promise<void> | null = null;

  const flush = async () => {
    if (abort.signal.aborted) return;
    const changed = latest !== sent;
    if (!changed && Date.now() - lastContact < HEARTBEAT_MS) return;
    const out = latest;
    try {
      const r = await api.update(job.id, changed ? { output: out } : {});
      sent = out;
      lastContact = Date.now();
      if (r.cancelled) {
        log(`job ${job.id} cancelled by user`);
        abort.abort();
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 401)) abort.abort(); // reclaimed, finished elsewhere, or token revoked
      else log(`progress update failed: ${(e as Error).message}`);
    }
  };
  const ticker = setInterval(() => {
    flushing ??= flush().finally(() => (flushing = null));
  }, FLUSH_MS);

  try {
    if (job.image) await writeFile(join(dir, "section.png"), decodePngDataUrl(job.image));
    if (job.context) await writeFile(join(dir, "context.md"), job.context);
    const result = await runAgent({
      cwd: dir,
      prompt: buildAgentPrompt(job),
      command: agentCommand(job.agent, cfg, !!job.image, job.options),
      timeoutMs: JOB_TIMEOUT_MS,
      onText: (t) => (latest = t),
      signal: abort.signal,
    });
    clearInterval(ticker);
    await flushing;
    if (result.status === "cancelled") return;
    await api.update(job.id, result.status === "done" ? { output: result.output, status: "done" } : { output: result.output, status: "error", error: result.error });
    log(`job ${job.id} ${result.status}${result.error ? `: ${result.error}` : ""}`);
  } catch (e) {
    log(`job ${job.id} failed: ${(e as Error).message}`);
    await api.update(job.id, { status: "error", error: (e as Error).message }).catch(() => {});
  } finally {
    clearInterval(ticker);
    await rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  const cfg = await loadConfig();
  if (!cfg) throw new Error("not set up: run `pbpaste | node bridge/padsync-bridge.ts setup --server <url>` first");
  const agents = (cfg.agents ?? AGENTS).filter((a) => {
    const v = available(a, cfg);
    log(`${a}: ${v ?? "not found, skipping"}`);
    return !!v;
  });
  if (!agents.length) throw new Error("neither claude nor codex is on PATH");
  const api = new BridgeApi(cfg);
  const info = { hostname: hostname(), version: VERSION };
  log(`bridge ${VERSION} polling ${cfg.server} as ${maskToken(cfg.token)}`);

  let backoff = POLL_MS;
  for (;;) {
    try {
      const { job } = await api.claim(agents, info);
      backoff = POLL_MS;
      if (job) {
        await handleJob(api, cfg, job);
        continue; // check for the next job immediately
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        log("device token was rejected (revoked or wrong server). Create a new one in padSync → Settings, then run setup again.");
        process.exit(2);
      }
      log(`poll failed: ${(e as Error).message}; retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    await sleep(POLL_MS);
  }
}

function plistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

async function install() {
  if (!(await loadConfig())) throw new Error("run setup first");
  const script = resolve(fileURLToPath(import.meta.url));
  const logFile = join(homedir(), "Library", "Logs", "padsync-bridge.log");
  await mkdir(dirname(plistPath()), { recursive: true });
  await mkdir(dirname(logFile), { recursive: true });
  await writeFile(plistPath(), launchdPlist({ node: process.execPath, script, path: process.env.PATH ?? "/usr/bin:/bin", logFile }));
  const domain = `gui/${process.getuid?.() ?? 501}`;
  spawnSync("launchctl", ["bootout", domain, plistPath()], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", domain, plistPath()], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  console.log(`Installed ${plistPath()}; the bridge now runs in the background. Logs: ${logFile}`);
}

async function uninstall() {
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plistPath()], { stdio: "ignore" });
  await unlink(plistPath()).catch(() => {});
  console.log("Uninstalled the launchd agent. (Config left in place; delete it to forget the token.)");
}

const commands: Record<string, () => Promise<unknown>> = { setup, status, run, install, uninstall };
const cmd = commands[process.argv[2] ?? ""];
if (!cmd) {
  console.log("usage: padsync-bridge <setup|status|run|install|uninstall>");
  process.exit(1);
}
cmd().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
