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
  chatHistory,
  resumeCommand,
  runChatWithFallback,
  ApiError,
  BridgeApi,
  LAUNCHD_LABEL,
  agentCommand,
  agentEnv,
  claudeThinkingSupported,
  attachedImages,
  buildAgentPrompt,
  buildBundlePrompt,
  buildImportPrompt,
  cleanOptions,
  collectOutFiles,
  configPath,
  fetchUploads,
  inlineTexts,
  launchdPlist,
  loadConfig,
  maskToken,
  normalizeServer,
  runAgent,
  saveConfig,
  sweepStaleJobDirs,
  withJobDir,
  type Agent,
  type BridgeConfig,
  type ClaimedJob,
  type JobFile,
  VOICE_PATH_RE,
} from "./lib.ts";
import { discoverCatalog, type Catalog } from "./catalog.ts";
import { Speech, uvVersion } from "./speech.ts";
import type { LiveStatus } from "./live-query.ts";

const VERSION = "0.5.0";
const POLL_MS = 3000;
// For a while after a job, poll faster: a follow-up question in the same chat is likely.
const FOLLOW_UP_POLL_MS = 1000;
const FOLLOW_UP_MS = 5 * 60_000;
// With the live query connected a new job wakes the bridge at once, so polling is a backup. A claim
// is also the bridge's heartbeat, and padSync calls a bridge silent for 30 s offline.
const LIVE_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
// How often new text goes to padSync while the agent writes (only the new part is sent).
const FLUSH_MS = 250;
// Even with no new text, check in this often: it is how a silent agent learns it was cancelled,
// and it keeps the job from looking stale (and being reclaimed) during long thinking.
const HEARTBEAT_MS = 5000;
const JOB_TIMEOUT_MS = 15 * 60_000;
// Reading a whole lecture and writing notes takes longer than answering a question.
const IMPORT_TIMEOUT_MS = 30 * 60_000;
// A job directory this old cannot belong to a live job (they time out after JOB_TIMEOUT_MS).
const STALE_JOB_DIR_MS = 60 * 60_000;
// On SIGTERM/SIGINT: how long the "bridge stopped" report may take, and the hard exit after that.
const SHUTDOWN_REPORT_MS = 5000;
const SHUTDOWN_EXIT_MS = 10_000;
// Re-read the Claude/Codex logins and model caches this often; sent to padSync only when they change.
const CATALOG_MS = 5 * 60_000;
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
  console.log(`speech  ${cfg.speech === false ? "off" : (uvVersion(cfg.speech?.uvBin) ?? "uv not found (brew install uv)")}`);
  const catalog = await discoverCatalog({ agents: cfg.agents ?? AGENTS, codexHomes: cfg.codexHomes });
  for (const a of catalog.accounts) console.log(`account ${a.id.padEnd(16)} ${a.label}${a.detail ? ` (${a.detail})` : ""}: ${a.models.length} models${catalog.homes[a.id] ? `, ${catalog.homes[a.id]}` : ""}`);
  try {
    const me = await new BridgeApi(cfg).whoami();
    console.log(`auth    ok (device "${me.device.name}")`);
  } catch (e) {
    console.log(`auth    FAILED: ${(e as Error).message}`);
  }
}

/**
 * Watches padSync's queued jobs over Neon Realtime and calls `onChange` when they change. Falls back
 * to polling alone when Realtime isn't configured or its client can't load on this Mac.
 */
async function watchJobs(api: BridgeApi, origin: string, onChange: () => void, onStatus: (s: LiveStatus) => void) {
  try {
    const { watchLive } = await import("./live-query.ts");
    return watchLive({ capability: (signal) => api.live({ signal }), onChange, onStatus, origin });
  } catch (e) {
    log(`realtime: unavailable (${(e as Error).message}), polling only`);
    return () => {};
  }
}

/** Aborted on SIGTERM/SIGINT so the running agent is stopped and its job directory removed. */
const shutdown = new AbortController();

function reportStopped(api: BridgeApi, jobId: string, output = "") {
  return api
    .update(jobId, { output, status: "error", error: "the Mac bridge was stopped before finishing; ask again" }, { timeoutMs: SHUTDOWN_REPORT_MS })
    .then(() => log(`job ${jobId} reported as stopped`))
    .catch((e) => log(`could not report job ${jobId} as stopped: ${(e as Error).message}`));
}

/** This Claude Code can show its thinking (bridge/lib.ts claudeThinkingSupported); checked at start. */
let claudeThinking = false;

/** The latest discovered catalog; handleJob maps a job's account to its CODEX_HOME with it. */
let catalog: Catalog = { accounts: [], homes: {} };

/** Transcribes voice messages; null when they are turned off or uv is missing. */
let speech: Speech | null = null;

/** The text of a voice message, written to a private temp file for the speech worker. */
async function transcribe(file: JobFile, signal: AbortSignal) {
  if (!speech) throw new Error("This Mac can't transcribe voice messages yet: install uv (brew install uv) and restart the bridge.");
  const dir = await mkdtemp(join(tmpdir(), "padsync-voice-"));
  try {
    const path = join(dir, file.path);
    await writeFile(path, Buffer.from(file.base64 ?? "", "base64"), { mode: 0o600, flag: "wx" });
    return await speech.transcribe(path, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function handleJob(api: BridgeApi, cfg: BridgeConfig, job: ClaimedJob, trace: Record<string, number> = {}) {
  // Latency stamps (src/lib/chat-trace.ts), sent with every update; the first stamp of each counts.
  const mark = (event: string) => (trace[`bridge.${event}`] ??= Date.now());
  trace["bridge.updates"] = 0;
  trace["bridge.update_ms"] = 0;
  const update = async (u: Parameters<BridgeApi["update"]>[1], opts?: Parameters<BridgeApi["update"]>[2]) => {
    if (u.status) mark("final_sent");
    const sentAt = Date.now();
    const r = await api.update(job.id, { ...u, trace: { ...trace } }, opts);
    trace["bridge.updates"]++;
    trace["bridge.update_ms"] += Date.now() - sentAt;
    return r;
  };
  const isImport = job.kind === "import";
  // An import's result is a file in out/, so it may always write there.
  const o = cleanOptions(job.agent, isImport ? { ...job.options, allowEdits: true } : job.options);
  const how = [isImport && "import", o.model, o.effort && `effort ${o.effort}`, o.webSearch && "web search", o.allowEdits && "edits", o.allowCode && "code", (job.files?.length || job.uploads?.length) && `${(job.files?.length ?? 0) + (job.uploads?.length ?? 0)} files`].filter(Boolean).join(", ");
  log(`job ${job.id} (${job.agent}${how ? `: ${how}` : ""}): ${job.question.slice(0, 80)}`);
  // A Codex job runs under the login it names; one this Mac doesn't have fails instead of silently
  // using another account's limits.
  const codexHome = job.agent === "codex" && o.account ? catalog.homes[o.account] : undefined;
  if (job.agent === "codex" && o.account && !codexHome) {
    log(`job ${job.id}: unknown Codex account ${o.account}`);
    await update({ status: "error", error: `Codex account "${o.account}" isn't set up on this Mac. Pick another model.` }).catch(() => {});
    return;
  }
  const abort = new AbortController();
  const onShutdown = () => abort.abort();
  shutdown.signal.addEventListener("abort", onShutdown);
  if (shutdown.signal.aborted) abort.abort();
  let latest = "";
  let sent = "";
  // The thinking travels beside the answer, the same way.
  let latestThinking = "";
  let sentThinking = "";
  // After a failed update the server may or may not have its text, so the next one resends it all.
  let synced = true;
  let lastContact = Date.now();
  let flushing: Promise<void> | null = null;

  const flush = async () => {
    if (abort.signal.aborted) return;
    const changed = latest !== sent;
    const thought = latestThinking !== sentThinking;
    if (!changed && !thought && Date.now() - lastContact < HEARTBEAT_MS) return;
    const out = latest;
    const th = latestThinking;
    const body = {
      ...(!changed ? {} : synced && sent && out.startsWith(sent) ? { append: out.slice(sent.length) } : { output: out }),
      ...(!thought ? {} : synced && sentThinking && th.startsWith(sentThinking) ? { thinkingAppend: th.slice(sentThinking.length) } : { thinking: th }),
    };
    try {
      // Cancelled with the job, so a hung progress request can't hold up stopping it.
      const r = await update(body, { signal: abort.signal });
      sent = out;
      sentThinking = th;
      synced = true;
      lastContact = Date.now();
      if (r.cancelled) {
        log(`job ${job.id} cancelled by user`);
        abort.abort();
      }
    } catch (e) {
      synced = false;
      if (e instanceof ApiError && (e.status === 409 || e.status === 401)) abort.abort(); // reclaimed, finished elsewhere, or token revoked
      else log(`progress update failed: ${(e as Error).message}`);
    }
  };
  const ticker = setInterval(() => {
    flushing ??= flush().finally(() => (flushing = null));
  }, FLUSH_MS);

  try {
    // Large inputs come in parts; once fetched they are ordinary job files for withJobDir.
    if (job.uploads?.length) {
      latest = "_Fetching the attached files…_";
      const fetched = await fetchUploads(api, job, abort.signal, (done, total) => (latest = `_Fetching the attached files… ${Math.round((done / total) * 100)}%_`));
      job = { ...job, files: [...(job.files ?? []), ...fetched] };
      latest = "";
      mark("inputs_fetched");
    }
    // A voice message becomes the question; the agent gets the words, not the audio.
    const voice = job.kind === "chat" ? job.files?.find((f) => VOICE_PATH_RE.test(f.path)) : undefined;
    if (voice) {
      const started = mark("transcribe_start");
      const heard = await transcribe(voice, abort.signal);
      mark("transcribed");
      if (!heard) throw new Error("No speech was heard in the voice message. Hold the mic (or ⌥M) and try again.");
      log(`job ${job.id}: transcribed in ${Date.now() - started} ms: ${heard.slice(0, 80)}`);
      // Anything typed before recording comes first.
      const question = [job.question.trim(), heard].filter(Boolean).join("\n\n").slice(0, 4000);
      await update({ question }, { signal: abort.signal });
      mark("transcript_sent");
      job = { ...job, question, files: job.files?.filter((f) => f !== voice) };
    }
    if (job.kind === 'chat') job = { ...job, files: job.files?.length ? job.files : [{path:'README.md',mime:'text/markdown',text:'Chat turn. Return changed files in out/ when edits are allowed.'}] };
    // Inputs and the agent's out/ share the job folder, so withJobDir's clean-up covers both,
    // whether the agent succeeds, fails, times out or is cancelled.
    const { result, files } = await withJobDir(job, async (d) => {
      const bundle = !!d.files;
      // Only bundle jobs have an out/ to write to; a legacy job stays read-only whatever it asks.
      const runOpts = bundle ? o : { ...o, allowEdits: false, allowCode: false };
      let session = job.thread?.agent_session;
      // A Codex session lives in one CODEX_HOME, so another account starts over from the history.
      const sameLogin = job.agent !== "codex" || (session?.account ?? undefined) === o.account;
      if (session?.agent !== job.agent || !sameLogin) session = null;
      // In the prompt rather than a file, which would cost the agent a tool round trip to read.
      const historyPrompt = () => `The conversation so far:\n<conversation>\n${chatHistory(job.history ?? [])}\n</conversation>\n\n`;
      // An import's lecture notes are long and read selectively, so only chats and asks inline them.
      const basePrompt = isImport ? buildImportPrompt(job.question, d, job.agent, runOpts) : bundle ? buildBundlePrompt(job.question, d, job.agent, runOpts, inlineTexts(job.files)) : buildAgentPrompt(job.question, d, job.agent);
      const command = agentCommand(job.agent, { ...cfg, claudeThinking }, bundle ? attachedImages(d.files) : !!d.image, runOpts);
      const run = (resume: boolean, prefix: string) => {
        mark("agent_spawn");
        return runAgent({
        cwd: d.dir,
        prompt: prefix + basePrompt,
        command: resume && session ? resumeCommand(command, job.agent, session.sessionId) : command,
        timeoutMs: isImport ? IMPORT_TIMEOUT_MS : JOB_TIMEOUT_MS,
        onText: (t) => {
          mark("first_text");
          // When the answer itself began (it restarts after a preamble moves to thinking): the chat's "Thought for".
          if (t && !latest) trace["bridge.answer_start"] = Date.now();
          latest = t;
        },
        onThinking: (t) => {
          mark("first_thinking");
          latestThinking = t;
        },
        onFirstLine: () => mark("agent_first_event"),
        signal: abort.signal,
        ...(codexHome ? { env: { ...agentEnv(), CODEX_HOME: codexHome } as unknown as NodeJS.ProcessEnv } : {}),
        });
      };
      const result = job.kind === 'chat'
        ? await runChatWithFallback(!!session, async (resume, history) => {
          latest = '';
          latestThinking = '';
          return run(resume, history ? historyPrompt() : '');
        })
        : await run(false, '');
      mark("agent_exit");
      let files: JobFile[] = [];
      if (result.status === "done" && d.out && runOpts.allowEdits) {
        // A failure here must not cost the answer.
        const got = await collectOutFiles(d.out).catch((e: Error) => ({ files: [] as JobFile[], skipped: [`all files (${e.message})`] }));
        files = got.files;
        if (got.skipped.length) result.output += `\n\n_Not returned from out/: ${got.skipped.join("; ")}._`;
        if (files.length) log(`job ${job.id} returned ${files.length} file(s)`);
      }
      return { result, files };
    });
    clearInterval(ticker);
    await flushing;
    if (result.status === "cancelled") {
      // Tell padSync now rather than leaving the job to go stale and be reclaimed in 10 minutes.
      if (shutdown.signal.aborted) await reportStopped(api, job.id, result.output);
      return;
    }
    const thinking = result.thinking ?? "";
    if (result.status !== "done") await update({ output: result.output, thinking, status: "error", error: result.error });
    else if (!files.length) await update({ output: result.output, thinking, status: "done", sessionId: result.sessionId });
    else {
      // Keep the answer even if padSync refuses the files (e.g. an older server).
      await update({ output: result.output, thinking, status: "done", sessionId: result.sessionId, files }).catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 400) throw e;
        log(`job ${job.id}: server refused the returned files: ${e.message}`);
        return update({ output: `${result.output}\n\n_The files the agent wrote could not be returned: ${e.message}_`, status: "done", sessionId: result.sessionId });
      });
    }
    log(`job ${job.id} ${result.status}${result.error ? `: ${result.error}` : ""}`);
  } catch (e) {
    clearInterval(ticker);
    await flushing;
    // Stopped while fetching the uploads: cancelled by the user (nothing to report) or shutdown.
    if (abort.signal.aborted) {
      if (shutdown.signal.aborted) await reportStopped(api, job.id);
      else log(`job ${job.id} cancelled while fetching its files`);
      return;
    }
    log(`job ${job.id} failed: ${(e as Error).message}`);
    await update({ status: "error", error: (e as Error).message }).catch(() => {});
  } finally {
    clearInterval(ticker);
    shutdown.signal.removeEventListener("abort", onShutdown);
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
  claudeThinking = agents.includes("claude") && claudeThinkingSupported(cfg.claudeBin);
  if (agents.includes("claude")) log(claudeThinking ? "claude: thinking summaries on" : "claude: this version can't show thinking (no --thinking-display)");
  const api = new BridgeApi(cfg);
  const info = { hostname: hostname(), version: VERSION };
  // Load the speech model now, so the first voice message is as quick as the rest.
  const speechCfg = cfg.speech === false ? null : (cfg.speech ?? {});
  const uv = speechCfg && uvVersion(speechCfg.uvBin);
  if (speechCfg && uv) {
    speech = new Speech({ ...speechCfg, log });
    log(`speech: ${uv}, loading the voice model`);
    void speech.start().catch(() => {});
  } else log(speechCfg ? "speech: uv not found, voice messages are off (brew install uv)" : "speech: turned off in the config");
  const features = ["import", "chat", ...(speech ? ["voice"] : [])];
  const swept = await sweepStaleJobDirs(STALE_JOB_DIR_MS);
  if (swept) log(`removed ${swept} job folder(s) left over from an earlier run`);
  // One poll: the claim and, if it returned a job, running it. Shutdown waits for the whole of it,
  // so a job the server handed out while the claim was in flight is still reported, not abandoned.
  let active: Promise<boolean> | null = null;
  const stop = (sig: string) => {
    if (shutdown.signal.aborted) return;
    log(`${sig}: stopping`);
    shutdown.abort();
    speech?.stop();
    setTimeout(() => process.exit(1), SHUTDOWN_EXIT_MS).unref();
    void Promise.resolve(active)
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  log(`bridge ${VERSION} polling ${cfg.server} as ${maskToken(cfg.token)}`);
  let sentCatalog = "";
  let catalogAt = 0;
  // Discovery is local and quick, so jobs always see current logins; the upload runs beside the
  // claim loop so a slow server never delays a job.
  const refreshCatalog = async () => {
    catalogAt = Date.now();
    catalog = await discoverCatalog({ agents, codexHomes: cfg.codexHomes }).catch(() => catalog);
    const body = JSON.stringify(catalog.accounts);
    if (body === sentCatalog) return;
    sentCatalog = body;
    api.catalog(catalog.accounts).then(
      () => log(`accounts: ${catalog.accounts.map((a) => `${a.id} (${a.models.length} models)`).join(", ")}`),
      (e: Error) => {
        // An older padSync has no catalog endpoint; the picker then shows its built-in list.
        sentCatalog = "";
        log(`could not send the model list: ${e.message}`);
      },
    );
  };

  // A change to the queued jobs ends the wait between polls early. One that lands while a claim is
  // in flight (which may have looked before the job was queued) makes the next wait end at once.
  let live = false;
  let woken = false;
  let endNap: (() => void) | null = null;
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      if (woken || shutdown.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      endNap = done;
      function done() {
        clearTimeout(timer);
        endNap = null;
        resolve();
      }
    });
  const stopWatching = await watchJobs(
    api,
    cfg.server,
    () => {
      woken = true;
      endNap?.();
    },
    (s) => {
      if ((s === "live") !== live) log(s === "live" ? "realtime: live, new jobs start at once" : `realtime: ${s}, polling every ${POLL_MS / 1000}s`);
      live = s === "live";
    },
  );
  shutdown.signal.addEventListener("abort", () => {
    stopWatching();
    endNap?.();
  });

  let backoff = POLL_MS;
  let lastJobAt = 0;
  while (!shutdown.signal.aborted) {
    if (Date.now() - catalogAt > CATALOG_MS) await refreshCatalog();
    woken = false;
    try {
      const claimSent = Date.now();
      active = api.claim(agents, info, features).then(async ({ job, serverTime }) => {
        if (!job) return false;
        const claimed = Date.now();
        // Server clock minus ours, from this round trip, so traces line up across machines.
        const trace: Record<string, number> = { "bridge.claim_sent": claimSent, "bridge.claimed": claimed, "bridge.claim_rtt": claimed - claimSent };
        if (serverTime) trace["bridge.clock_offset"] = serverTime - (claimSent + claimed) / 2;
        if (shutdown.signal.aborted) await reportStopped(api, job.id);
        else await handleJob(api, cfg, job, trace);
        return true;
      });
      const hadJob = await active.finally(() => (active = null));
      backoff = POLL_MS;
      if (hadJob) {
        lastJobAt = Date.now();
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
    await nap(live ? LIVE_POLL_MS : Date.now() - lastJobAt < FOLLOW_UP_MS ? FOLLOW_UP_POLL_MS : POLL_MS);
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
