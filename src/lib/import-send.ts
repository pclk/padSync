import { attachmentPaths, type AttachmentMeta } from "./attachments";
import { importInlineFiles, importJobBody, splitParts, type ImportConfig } from "./ai-import";
import { base64Length, partsFor, type UploadSpec } from "./uploads";

// Sends an AI import to the bridge: creates the job with its upload manifest, then PUTs each
// lecture file in parts. Cancelling (the signal) or a failed part cancels the job on the server,
// so nothing is left half-uploaded for the bridge to pick up.

export interface SendAttachment {
  meta: Pick<AttachmentMeta, "name" | "mime" | "kind" | "size">;
  base64: () => Promise<string>;
}

export interface SendProgress {
  phase: "reading" | "creating" | "uploading";
  sent: number;
  total: number;
}

export class SendError extends Error {
  jobId: string | null;
  constructor(message: string, jobId: string | null = null) {
    super(message);
    this.jobId = jobId;
  }
}

const RETRIES = 2;

export function friendlyHttpError(status: number, error?: string) {
  if (status === 401) return "Sign in on the Settings page first.";
  if (status === 503) return "The server database is not set up.";
  if (status === 413) return "The request was too large for the server.";
  return error ?? `The server answered ${status}.`;
}

async function json(res: Response) {
  return (await res.json().catch(() => ({}))) as { error?: string; job?: { id: string }; status?: string };
}

export async function sendImport(opts: {
  config: ImportConfig;
  attachments: SendAttachment[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: SendProgress) => void;
  /** Called as soon as the job exists, so the page can track (and cancel) it. */
  onJob?: (id: string) => void;
}): Promise<{ jobId: string; status: string }> {
  const f = opts.fetch ?? fetch;
  const signal = opts.signal;
  const metas = opts.attachments.map((a) => a.meta);
  const paths = attachmentPaths(metas);
  if (!opts.attachments.length) throw new SendError("Attach at least one file of lecture notes first.");

  // Sizes are known from the byte counts, so each file is read only when its turn comes: a
  // 40 MB import never sits in memory as base64 all at once.
  const specs: UploadSpec[] = metas.map((m, i) => ({ path: paths[i], mime: m.mime, size: base64Length(m.size), parts: partsFor(base64Length(m.size)) }));
  const total = specs.reduce((n, s) => n + s.size, 0);

  opts.onProgress?.({ phase: "creating", sent: 0, total });
  const res = await f("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(importJobBody(opts.config, importInlineFiles(opts.config, metas), specs)), signal });
  const created = await json(res);
  if (!res.ok || !created.job) throw new SendError(friendlyHttpError(res.status, created.error));
  const jobId = created.job.id;
  opts.onJob?.(jobId);

  let sent = 0;
  let status = "uploading";
  try {
    upload: for (const [i, spec] of specs.entries()) {
      signal?.throwIfAborted();
      opts.onProgress?.({ phase: "reading", sent, total });
      const content = await opts.attachments[i].base64();
      if (content.length !== spec.size) throw new SendError(`${metas[i].name} changed while it was being sent. Try again.`, jobId);
      for (const [part, data] of splitParts(content).entries()) {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted();
          const r = await f(`/api/jobs/${encodeURIComponent(jobId)}/inputs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: spec.path, part, data }), signal }).catch((e: Error) => {
            if (signal?.aborted) throw e;
            return null; // network error: retry
          });
          if (r?.ok) {
            status = (await json(r)).status ?? status;
            break;
          }
          // A 409 saying the job already moved on means every part arrived: the response to the
          // last one was lost and this was its retry. Cancelling now would throw away a good job.
          if (r?.status === 409) {
            const s = ((await r.clone().json().catch(() => ({}))) as { jobStatus?: string }).jobStatus;
            if (s === "queued" || s === "running" || s === "done") {
              status = s;
              sent = total;
              opts.onProgress?.({ phase: "uploading", sent, total });
              break upload;
            }
          }
          // 4xx other than a timeout won't get better by retrying.
          if (r && r.status < 500 && r.status !== 408) throw new SendError(`Uploading ${metas[i].name} failed: ${friendlyHttpError(r.status, (await json(r)).error)}`, jobId);
          if (attempt >= RETRIES) throw new SendError(`Uploading ${metas[i].name} failed${r ? ` (${r.status})` : ": no connection"}. Try again.`, jobId);
        }
        sent += data.length;
        opts.onProgress?.({ phase: "uploading", sent, total });
      }
    }
  } catch (e) {
    // Leave nothing half-uploaded: a cancelled job's parts are deleted on the server.
    await f(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => null);
    if (e instanceof SendError) throw e;
    if (signal?.aborted) throw new SendError("Cancelled.", jobId);
    throw new SendError((e as Error).message, jobId);
  }
  return { jobId, status };
}

// ---------------------------------------------------------------------------------------------
// The page's send, kept outside React: leaving the page doesn't stop an upload, and coming back
// shows its progress again. The current job id is stored too, so a reload resumes following it.

export interface SendState {
  jobId: string | null;
  progress: SendProgress | null;
  error: string | null;
}

const JOB_KEY = "padsync.import.jobId";
let state: SendState | null = null;
let inflight: AbortController | null = null;
const listeners = new Set<() => void>();

function readJobId(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(JOB_KEY) ?? "null");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function update(patch: Partial<SendState>) {
  state = { ...getSendState(), ...patch };
  if ("jobId" in patch)
    try {
      localStorage.setItem(JOB_KEY, JSON.stringify(state.jobId));
    } catch {}
  for (const l of listeners) l();
}

export function getSendState(): SendState {
  return (state ??= { jobId: readJobId(), progress: null, error: null });
}

export function subscribeSend(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function setCurrentJob(jobId: string | null) {
  update({ jobId, error: null });
}

/** Starts a send unless one is already running (a second tap does nothing). */
export async function startSend(opts: Omit<Parameters<typeof sendImport>[0], "signal" | "onProgress" | "onJob">): Promise<void> {
  if (inflight) return;
  const ac = new AbortController();
  inflight = ac;
  update({ progress: { phase: "creating", sent: 0, total: 0 }, error: null });
  try {
    await sendImport({ ...opts, signal: ac.signal, onProgress: (progress) => update({ progress }), onJob: (jobId) => update({ jobId }) });
    update({ progress: null });
  } catch (e) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    update({ progress: null, error: e instanceof SendError ? e.message : offline ? "You're offline; sending needs a connection." : (e as Error).message });
  } finally {
    inflight = null;
  }
}

export function abortSend() {
  inflight?.abort();
}

export const isSending = () => inflight !== null;
