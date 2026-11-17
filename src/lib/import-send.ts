import { attachmentPaths, type AttachmentMeta } from "./attachments";
import { importInlineFiles, importJobBody, splitParts, uploadSpecs, type ImportConfig } from "./ai-import";

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

  const contents: string[] = [];
  for (const [i, a] of opts.attachments.entries()) {
    signal?.throwIfAborted();
    opts.onProgress?.({ phase: "reading", sent: i, total: opts.attachments.length });
    contents.push(await a.base64());
  }
  const specs = uploadSpecs(contents.map((base64, i) => ({ path: paths[i], mime: metas[i].mime, base64 })));
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
    for (const [i, spec] of specs.entries()) {
      for (const [part, data] of splitParts(contents[i]).entries()) {
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
