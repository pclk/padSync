import type {
  CatalogResponse,
  NewThread,
  NewTurn,
  ThreadPatch,
  ThreadSummary,
  ThreadResponse,
  ThreadListResponse,
  Turn,
} from "./chat-types";
import type { PricingResponse } from "./chat-cost";
import type { LiveCapability } from "./live-query";
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("You're offline; chat needs a connection.");
  }
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? "Sign in on the Settings page first."
        : res.status === 503
          ? "Server database is not set up."
          : (data.error ?? `HTTP ${res.status}`),
    );
  return data;
}
const path = (id: string) => `/api/chat/threads/${encodeURIComponent(id)}`;
export const listThreads = (
  filter: { notebookId?: string; q?: string; archived?: boolean } = {},
) =>
  call<ThreadListResponse>(
    "/api/chat/threads?" +
      new URLSearchParams(
        Object.entries(filter)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [
            k,
            typeof v === "boolean" ? (v ? "1" : "0") : String(v),
          ]),
      ),
  );
export const createThread = (input: NewThread) =>
  call<{ thread: ThreadSummary }>("/api/chat/threads", "POST", input);
export const updateThread = (id: string, input: ThreadPatch) =>
  call<{ thread: ThreadSummary }>(path(id), "PATCH", input);
export const deleteThread = (id: string) =>
  call<{ ok: true }>(path(id), "DELETE");
export const getThread = (
  id: string,
  query: { since?: string; from?: string } = {},
) =>
  call<ThreadResponse>(
    path(id) +
      "?" +
      new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
  );
export const sendTurn = (id: string, input: NewTurn) =>
  call<{ turn: Turn; serverTime?: number }>(path(id) + "/turns", "POST", input);
/** Adds this device's latency stamps to a turn's trace (src/lib/chat-trace.ts). */
export const addTrace = (jobId: string, trace: Record<string, number>) =>
  call<{ ok: true }>(`/api/jobs/${encodeURIComponent(jobId)}/trace`, "POST", { trace });
export const regenerateTurn = (id: string, turn: number) =>
  call<{ turn: Turn }>(path(id) + `/turns/${turn}/regenerate`, "POST");
export const forkThread = (id: string, uptoTurn: number, title?: string) =>
  call<{ thread: ThreadSummary }>(path(id) + "/fork", "POST", {
    uptoTurn,
    title,
  });
/** A sealed live query on the thread's turns (src/lib/live-query.ts). */
export const liveThread = (id: string) => call<LiveCapability>(path(id) + "/live", "POST");
export const getCatalog = () => call<CatalogResponse>("/api/chat/catalog");
export const getPricing = () => call<PricingResponse>("/api/chat/pricing");
/** Preferences synced to every device of the signed-in user (src/server/prefs.ts). */
export const getPrefs = () => call<{ prefs: Record<string, unknown>; updatedAt: Record<string, string> }>("/api/prefs");
export const putPref = (key: string, value: unknown) =>
  call<{ prefs: Record<string, unknown>; updatedAt: Record<string, string> }>("/api/prefs", "PUT", { key, value });
export const cancelTurn = (jobId: string) =>
  call<unknown>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, "POST");
export function mergeTurns(prev: Turn[], incoming: Turn[]): Turn[] {
  const map = new Map(prev.map((t) => [t.turn, t]));
  for (const t of incoming) {
    const old = map.get(t.turn);
    if (old && old.updatedAt >= t.updatedAt) continue;
    if (
      t.outputOffset &&
      (!old || t.outputOffset > Array.from(old.output).length)
    )
      continue;
    map.set(t.turn, {
      ...t,
      output:
        (t.outputOffset
          ? Array.from(old!.output).slice(0, t.outputOffset).join("")
          : "") + t.output,
      outputOffset: 0,
    });
  }
  return [...map.values()].sort((a, b) => a.turn - b.turn);
}

/** Streaming offsets use Unicode code points, matching PostgreSQL length/substring. */
export function pollCursor(turns: Turn[]): string {
  return turns.map((t) => `${t.turn}:${Array.from(t.output).length}`).join(",");
}
export const editTurn = (threadId: string, turn: number, question: string) =>
  call<{ thread: ThreadSummary }>(
    path(threadId) + `/turns/${turn}/edit`,
    "POST",
    { question },
  );

import {
  MAX_UPLOAD_FILES,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  PART_CHARS,
  partsFor,
  type UploadSpec,
} from "./uploads";
type InputFile = { path: string; mime: string; base64: string };
export function uploadSpecs(files: InputFile[]): UploadSpec[] {
  if (files.length > MAX_UPLOAD_FILES)
    throw new Error(`Attach at most ${MAX_UPLOAD_FILES} files.`);
  const seen = new Set<string>();
  const specs = files.map((f) => {
    if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf|audio\/(mp4|webm|ogg|wav|mpeg))$/.test(f.mime))
      throw new Error("Attach an image (PNG, JPEG, WebP, GIF) or PDF.");
    if (
      !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)?$/.test(
        f.path,
      ) ||
      seen.has(f.path.toLowerCase())
    )
      throw new Error("Attachment names must be unique safe file paths.");
    seen.add(f.path.toLowerCase());
    if (!f.base64.length || f.base64.length > MAX_FILE_CHARS)
      throw new Error(`${f.path}: file must be between 1 byte and 25 MB.`);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        f.base64,
      )
    )
      throw new Error(`${f.path}: invalid base64 attachment.`);
    return {
      path: f.path,
      mime: f.mime,
      size: f.base64.length,
      parts: partsFor(f.base64.length),
    };
  });
  if (specs.reduce((n, s) => n + s.size, 0) > MAX_TOTAL_CHARS)
    throw new Error("Attachments may total at most 40 MB.");
  return specs;
}
export async function uploadTurnInputs(
  jobId: string,
  files: InputFile[],
  opts: {
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const specs = uploadSpecs(files);
  const total = specs.reduce((n, s) => n + s.size, 0);
  let sent = 0;
  opts.onProgress?.(sent, total);
  try {
    for (const [i, spec] of specs.entries()) {
      for (let part = 0; part < spec.parts; part++) {
        const data = files[i].base64.slice(
          part * PART_CHARS,
          (part + 1) * PART_CHARS,
        );
        for (let attempt = 0; ; attempt++) {
          opts.signal?.throwIfAborted();
          const res = await fetch(
            `/api/jobs/${encodeURIComponent(jobId)}/inputs`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: spec.path, part, data }),
              signal: opts.signal,
            },
          ).catch((e) => {
            if (opts.signal?.aborted) throw e;
            return null;
          });
          if (res?.ok) break;
          const body = await res?.json().catch(() => ({}));
          if (
            res?.status === 409 &&
            ["queued", "running", "done"].includes(body?.jobStatus)
          ) {
            opts.onProgress?.(total, total);
            return;
          }
          if (res && res.status < 500 && res.status !== 408)
            throw new Error(body?.error ?? `Upload failed (${res.status}).`);
          if (attempt >= 2)
            throw new Error(
              "Uploading failed. Check your connection and try again.",
            );
        }
        sent += data.length;
        opts.onProgress?.(sent, total);
      }
    }
  } catch (e) {
    await cancelTurn(jobId).catch(() => null);
    throw e;
  }
}
