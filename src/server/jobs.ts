import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BUNDLE_MIMES, BUNDLE_PATH_RE, MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, isBinaryMime } from "@/lib/context";
import type { Sql } from "./db";

// AI jobs: the iPad/Mac queue a question about a section; the Mac bridge claims it, runs
// Claude Code or Codex locally, and streams the answer back. Claiming and every state change are
// single SQL statements. Stale reclaim can overlap execution during network partitions.

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** A running job whose bridge went quiet this long is handed to the next claim. The bridge
 *  heartbeats every few seconds (an empty update), but network outages can also make a live bridge appear stale. */
export const STALE_AFTER_S = 600;
export const MAX_OUTPUT = 200_000;
const MAX_IMAGE = 3_000_000; // data URL chars; keeps requests under Vercel's 4.5 MB limit
// Only the bridge reads image, context and files, and only while running, so all are dropped when a job
// finishes or is cancelled: otherwise every ask keeps a multi-MB PNG in Postgres forever.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** How the bridge runs the agent. Unset fields fall back to the agent's own defaults. */
export const jobOptionsSchema = z
  .object({
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/, "model: letters, digits and . _ : - [ ] only").optional(),
    effort: z.enum(EFFORTS).optional(),
    webSearch: z.boolean().optional(),
    /** The agent may write changed copies of the inputs into out/. */
    allowEdits: z.boolean().optional(),
    /** Claude also gets Bash (Codex always runs commands in its sandbox). */
    allowCode: z.boolean().optional(),
  })
  .strict();
export type JobOptions = z.infer<typeof jobOptionsSchema>;

export const MAX_RESULT_FILES = 20;
export const MAX_RESULT_BYTES = 2_000_000;

const fileSize = (f: { text?: string; base64?: string }) => (f.text?.length ?? 0) + (f.base64?.length ?? 0);

/** A file in a job's temp dir: inputs from padSync, or what the agent wrote to out/. */
export const jobFileSchema = z
  .object({
    path: z.string().regex(BUNDLE_PATH_RE, "path: letters, digits, . _ - and one folder; no leading dot"),
    mime: z.enum(BUNDLE_MIMES),
    text: z.string().optional(),
    base64: z.string().regex(/^[A-Za-z0-9+/]*=*$/, "base64 only").optional(),
  })
  .strict()
  .refine((f) => (f.text === undefined) !== (f.base64 === undefined), "a file has text or base64, not both")
  .refine((f) => (f.base64 !== undefined) === isBinaryMime(f.mime), "images and PDFs are base64, text files are text");

const fileList = (maxFiles: number, maxBytes: number) =>
  z
    .array(jobFileSchema)
    .max(maxFiles)
    .refine((fs) => new Set(fs.map((f) => f.path.toLowerCase())).size === fs.length, "file paths must be unique")
    .refine((fs) => fs.reduce((n, f) => n + fileSize(f), 0) <= maxBytes, `files may total at most ${maxBytes} characters`);

export const jobFilesSchema = fileList(MAX_BUNDLE_FILES, MAX_BUNDLE_BYTES);
export const resultFilesSchema = fileList(MAX_RESULT_FILES, MAX_RESULT_BYTES);
export type JobFile = z.infer<typeof jobFileSchema>;

export const newJobSchema = z.object({
  notebookId: z.string().min(1).max(100),
  sectionId: z.string().min(1).max(100).nullable(),
  agent: z.enum(AGENTS),
  question: z.string().trim().min(1).max(4000),
  context: z.string().max(100_000).default(""),
  image: z
    .string()
    .max(MAX_IMAGE)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, "image must be a base64 PNG data URL")
    .nullable()
    .default(null),
  /** The context bundle (src/lib/context.ts). When present the bridge ignores context/image. */
  files: jobFilesSchema.default([]),
  options: jobOptionsSchema.default({}),
});

export const jobUpdateSchema = z
  .object({
    append: z.string().max(MAX_OUTPUT).optional(),
    output: z.string().max(MAX_OUTPUT).optional(),
    status: z.enum(["done", "error"]).optional(),
    error: z.string().max(4000).optional(),
    /** What the agent wrote to out/, sent with the final update. */
    files: resultFilesSchema.optional(),
  })
  .refine((u) => !(u.append !== undefined && u.output !== undefined), "send append or output, not both")
  .refine((u) => u.files === undefined || u.status === "done", "files come with the final done update");

export interface Job {
  id: string;
  notebookId: string;
  sectionId: string | null;
  agent: Agent;
  question: string;
  options: JobOptions;
  status: JobStatus;
  output: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** Files the agent returned (metadata only in lists; getJob includes content). */
  resultFiles: (Pick<JobFile, "path" | "mime"> & { size: number; text?: string; base64?: string })[];
}

export interface ClaimedJob extends Job {
  context: string;
  image: string | null;
  files: JobFile[];
}

interface Row {
  id: string;
  notebook_id: string;
  section_id: string | null;
  agent: Agent;
  question: string;
  options: JobOptions | null;
  status: JobStatus;
  output: string;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  finished_at: string | Date | null;
  context?: string;
  image?: string | null;
  files?: JobFile[] | null;
  result_files?: JobFile[] | null;
}

const PUBLIC_COLS = "id, notebook_id, section_id, agent, question, options, status, output, error, created_at, updated_at, finished_at, result_files";
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

function toJob(r: Row, withContent = false): Job {
  return {
    id: r.id,
    notebookId: r.notebook_id,
    sectionId: r.section_id,
    agent: r.agent,
    question: r.question,
    options: r.options ?? {},
    status: r.status,
    output: r.output,
    error: r.error,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    finishedAt: iso(r.finished_at),
    resultFiles: (r.result_files ?? []).map((f) => ({ path: f.path, mime: f.mime, size: fileSize(f), ...(withContent ? (f.base64 !== undefined ? { base64: f.base64 } : { text: f.text }) : {}) })),
  };
}

export async function createJob(sql: Sql, input: z.input<typeof newJobSchema> & Omit<z.infer<typeof newJobSchema>, "options" | "files">): Promise<Job> {
  const id = "job_" + randomBytes(9).toString("base64url");
  const rows = await sql.query<Row>(
    `insert into jobs (id, notebook_id, section_id, agent, question, context, image, options, files)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) returning ${PUBLIC_COLS}`,
    [id, input.notebookId, input.sectionId, input.agent, input.question, input.context, input.image, JSON.stringify(input.options ?? {}), input.files?.length ? JSON.stringify(input.files) : null],
  );
  return toJob(rows[0]);
}

export async function listJobs(sql: Sql, filter: { sectionId?: string; notebookId?: string }, limit = 20): Promise<Job[]> {
  const rows = filter.sectionId
    ? await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where section_id = $1 order by created_at desc limit $2`, [filter.sectionId, limit])
    : await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where notebook_id = $1 order by created_at desc limit $2`, [filter.notebookId ?? "", limit]);
  return rows.map((r) => toJob(r));
}

export async function getJob(sql: Sql, id: string): Promise<Job | null> {
  const rows = await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where id = $1`, [id]);
  return rows[0] ? toJob(rows[0], true) : null;
}

/** Cancels a queued or running job. Returns the job, or null if it was already finished/missing. */
export async function cancelJob(sql: Sql, id: string): Promise<Job | null> {
  const rows = await sql.query<Row>(
    `update jobs set status = 'cancelled', updated_at = now(), finished_at = now(), image = null, context = '', files = null
     where id = $1 and status in ('queued', 'running') returning ${PUBLIC_COLS}`,
    [id],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Atomically hands the oldest runnable job to this device (or reclaims a stale one). */
export async function claimJob(sql: Sql, deviceId: string, agents: readonly Agent[]): Promise<ClaimedJob | null> {
  if (!agents.length) return null;
  const rows = await sql.query<Row>(
    `update jobs set status = 'running', claimed_by = $1, claimed_at = now(), updated_at = now(), output = '', error = null
     where id = (
       select id from jobs
       where agent = any($2::text[])
         and (status = 'queued' or (status = 'running' and updated_at < now() - make_interval(secs => $3)))
       order by created_at
       limit 1
       for update skip locked
     )
     returning ${PUBLIC_COLS}, context, image, files`,
    [deviceId, agents, STALE_AFTER_S],
  );
  const r = rows[0];
  return r ? { ...toJob(r), context: r.context ?? "", image: r.image ?? null, files: r.files ?? [] } : null;
}

export type UpdateResult = { ok: true; status: JobStatus } | { ok: false; reason: "cancelled" | "not_claimed" };

/**
 * Applies a bridge update to a job it holds. Only the claiming device may write, and only while
 * the job is running. A cancelled job reports "cancelled" so the bridge stops the agent.
 */
export async function updateJob(sql: Sql, id: string, deviceId: string, u: z.infer<typeof jobUpdateSchema>): Promise<UpdateResult> {
  const rows = await sql.query<{ status: JobStatus }>(
    `update jobs set
       output = left(case when $3::text is not null then $3::text else output || coalesce($4::text, '') end, $7),
       status = coalesce($5::text, status),
       error = coalesce($6::text, error),
       updated_at = now(),
       finished_at = case when $5::text is not null then now() else finished_at end,
       image = case when $5::text is not null then null else image end,
       context = case when $5::text is not null then '' else context end,
       files = case when $5::text is not null then null else files end,
       result_files = coalesce($8::jsonb, result_files)
     where id = $1 and claimed_by = $2 and status = 'running'
     returning status`,
    [id, deviceId, u.output ?? null, u.append ?? null, u.status ?? null, u.error ?? null, MAX_OUTPUT, u.files ? JSON.stringify(u.files) : null],
  );
  if (rows[0]) return { ok: true, status: rows[0].status };
  const cur = await sql.query<{ status: JobStatus }>(`select status from jobs where id = $1 and claimed_by = $2`, [id, deviceId]);
  return { ok: false, reason: cur[0]?.status === "cancelled" ? "cancelled" : "not_claimed" };
}
