// Voice messages: runs bridge/transcribe.py (NVIDIA Parakeet on MLX) as a long-lived worker, so the
// model stays loaded between messages. Started with the bridge, stopped after a quiet spell, and
// started again on the next voice message. Erasable TypeScript only (see lib.ts).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned so a bridge restart never picks up an untested release. */
const PARAKEET = "parakeet-mlx==0.7.0";
const PYTHON = "3.12";
/** The first start downloads the model (~1.2 GB); later starts load it from the cache in seconds. */
const START_TIMEOUT_MS = 15 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 2 * 60_000;
/** Frees the model's ~2 GB after this long without a voice message. */
const IDLE_MS = 30 * 60_000;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "transcribe.py");

export interface SpeechOptions {
  uvBin?: string;
  /** A Hugging Face MLX Parakeet model; default mlx-community/parakeet-tdt-0.6b-v3. */
  model?: string;
  log?: (...a: unknown[]) => void;
}

type Pending = { resolve(text: string): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

/** `uv`'s version, or null when it is not installed. */
export function uvVersion(uvBin = "uv") {
  const r = spawnSync(uvBin, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** One line of the worker's output. */
export function parseWorkerLine(line: string): { ready: true; seconds?: number } | { id: string; text?: string; error?: string } | null {
  try {
    const v = JSON.parse(line);
    if (v?.ready === true) return { ready: true, seconds: typeof v.seconds === "number" ? v.seconds : undefined };
    if (typeof v?.id === "string" && (typeof v.text === "string" || typeof v.error === "string")) return v;
  } catch {
    // Libraries print progress to stdout now and then; it is not a reply.
  }
  return null;
}

export class Speech {
  private opts: SpeechOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private next = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SpeechOptions = {}) {
    this.opts = opts;
  }

  /** Starts the worker (if it is not running) and resolves once the model is loaded and warm. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    const log = this.opts.log ?? (() => {});
    const started = Date.now();
    const child = spawn(
      this.opts.uvBin ?? "uv",
      ["run", "--no-project", "--quiet", "--python", PYTHON, "--with", PARAKEET, "python", "-I", SCRIPT],
      {
        env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1", ...(this.opts.model ? { PADSYNC_SPEECH_MODEL: this.opts.model } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdin.on("error", () => {}); // a dead worker is reported by "exit"
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the speech model took too long to load"));
        child.kill();
      }, START_TIMEOUT_MS);
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = parseWorkerLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (!msg) continue;
          if ("ready" in msg) {
            clearTimeout(timer);
            log(`speech: model ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
            resolve();
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.text ?? "");
        }
      });
      const fail = (why: string) => {
        clearTimeout(timer);
        const e = new Error(`speech worker ${why}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
        reject(e);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(e);
        }
        this.pending.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      };
      child.on("error", (e) => fail(`could not start (${e.message})`));
      child.on("exit", (code, signal) => fail(`exited (${signal ?? code})`));
    });
    // Nobody may be waiting on a warm-up start; its failure is logged, not thrown.
    this.ready.catch((e: Error) => log(`speech: ${e.message}`));
    return this.ready;
  }

  /** The text of the audio file at `path` (any format ffmpeg reads). */
  async transcribe(path: string, signal?: AbortSignal): Promise<string> {
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.start();
      const child = this.child;
      if (!child) throw new Error("speech worker is not running");
      signal?.throwIfAborted();
      const id = String(++this.next);
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("transcription timed out"));
        }, TRANSCRIBE_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, timer });
        signal?.addEventListener("abort", () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled"));
        }, { once: true });
        child.stdin.write(JSON.stringify({ id, path }) + "\n");
      });
    } finally {
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
      this.idle.unref();
    }
  }

  stop() {
    if (this.idle) clearTimeout(this.idle);
    this.child?.kill();
  }
}
