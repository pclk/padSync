import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BUNDLE_MIMES, BUNDLE_PATH_RE, MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, isBinaryMime } from "@/lib/context";
import { MAX_FILE_CHARS, MAX_TOTAL_CHARS, MAX_UPLOAD_FILES, PART_CHARS, partLength, partsFor, type UploadSpec } from "@/lib/uploads";
import type { Sql } from "./db";

// AI jobs: the iPad/Mac queue a question about a section; the Mac bridge claims it, runs
// Claude Code or Codex locally, and streams the answer back. Claiming and every state change are
// single SQL statements. Stale reclaim can overlap execution during network partitions.

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];
export type JobStatus = "uploading" | "queued" | "running" | "done" | "error" | "cancelled";
/** "ask": a question about notebook sections. "import": make a new notebook from lecture files. */
export const JOB_KINDS = ["ask", "import", "chat"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

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
    /** Which Codex login on the Mac runs it (bridge/catalog.ts); the bridge checks it is one it has. */
    account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "account: letters, digits, _ and - only").optional(),
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

/** A large input sent in parts after the job is created (src/lib/uploads.ts). */
export const uploadSchema = z
  .object({
    path: z.string().regex(BUNDLE_PATH_RE, "path: letters, digits, . _ - and one folder; no leading dot"),
    mime: z.enum(BUNDLE_MIMES),
    size: z.number().int().positive().max(MAX_FILE_CHARS, `a file may be at most ${MAX_FILE_CHARS} base64 characters`),
    parts: z.number().int().positive(),
  })
  .strict()
  .refine((u) => u.size % 4 === 0, "size must be a base64 length (a multiple of 4)")
  .refine((u) => u.parts === partsFor(u.size), `parts must be size / ${PART_CHARS}, rounded up`);

export const newJobSchema = z.object({
  kind: z.enum(JOB_KINDS).default("ask"),
  /** Empty for an import, which has no notebook yet. */
  notebookId: z.string().max(100).default(""),
  sectionId: z.string().min(1).max(100).nullable().default(null),
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
  uploads: z.array(uploadSchema).max(MAX_UPLOAD_FILES).default([]),
  options: jobOptionsSchema.default({}),
})
  .refine((j) => j.kind === "import" || j.notebookId.length > 0, { path: ["notebookId"], message: "required for a question" })
  .refine((j) => j.kind === "import" || !j.uploads.length, { path: ["uploads"], message: "only imports send uploads" })
  .refine((j) => j.uploads.reduce((n, u) => n + u.size, 0) <= MAX_TOTAL_CHARS, { path: ["uploads"], message: `uploads may total at most ${MAX_TOTAL_CHARS} base64 characters` })
  .refine((j) => new Set([...j.files, ...j.uploads].map((f) => f.path.toLowerCase())).size === j.files.length + j.uploads.length, { path: ["uploads"], message: "file paths must be unique" });

export const jobInputSchema = z
  .object({
    path: z.string().regex(BUNDLE_PATH_RE),
    part: z.number().int().nonnegative(),
    data: z.string().max(PART_CHARS).regex(/^[A-Za-z0-9+/]*=*$/, "base64 only"),
  })
  .strict();

export const jobUpdateSchema = z
  .object({
    sessionId: z.string().min(1).max(200).optional(),
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
  kind: JobKind;
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
  /** Large inputs still to arrive (uploading) or to be fetched by the bridge. */
  uploads: UploadSpec[];
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
  kind?: JobKind;
  uploads?: UploadSpec[] | null;
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

const PUBLIC_COLS = "id, kind, uploads, notebook_id, section_id, agent, question, options, status, output, error, created_at, updated_at, finished_at, result_files";
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

function toJob(r: Row, withContent = false): Job {
  return {
    id: r.id,
    kind: r.kind ?? "ask",
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
    uploads: r.uploads ?? [],
    resultFiles: (r.result_files ?? []).map((f) => ({ path: f.path, mime: f.mime, size: fileSize(f), ...(withContent ? (f.base64 !== undefined ? { base64: f.base64 } : { text: f.text }) : {}) })),
  };
}

export async function createJob(
  sql: Sql,
  input: z.input<typeof newJobSchema> & Omit<z.infer<typeof newJobSchema>, "options" | "files" | "kind" | "uploads" | "notebookId"> & { notebookId?: string },
): Promise<Job> {
  const id = "job_" + randomBytes(9).toString("base64url");
  const uploads = input.uploads ?? [];
  const rows = await sql.query<Row>(
    `insert into jobs (id, kind, notebook_id, section_id, agent, question, context, image, options, files, uploads, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12) returning ${PUBLIC_COLS}`,
    [
      id,
      input.kind ?? "ask",
      input.notebookId ?? "",
      input.sectionId,
      input.agent,
      input.question,
      input.context,
      input.image,
      JSON.stringify(input.options ?? {}),
      input.files?.length ? JSON.stringify(input.files) : null,
      uploads.length ? JSON.stringify(uploads) : null,
      uploads.length ? "uploading" : "queued",
    ],
  );
  return toJob(rows[0]);
}

export async function listJobs(sql: Sql, filter: { sectionId?: string; notebookId?: string; kind?: JobKind }, limit = 20): Promise<Job[]> {
  const rows = filter.kind === "import"
    ? await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where kind = 'import' order by created_at desc limit $1`, [limit])
    : filter.sectionId
    ? await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where thread_id is null and section_id = $1 order by created_at desc limit $2`, [filter.sectionId, limit])
    : await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where thread_id is null and notebook_id = $1 order by created_at desc limit $2`, [filter.notebookId ?? "", limit]);
  return rows.map((r) => toJob(r));
}

export async function getJob(sql: Sql, id: string): Promise<Job | null> {
  const rows = await sql.query<Row>(`select ${PUBLIC_COLS} from jobs where id = $1`, [id]);
  return rows[0] ? toJob(rows[0], true) : null;
}

/** Cancels a queued or running job. Returns the job, or null if it was already finished/missing. */
export async function cancelJob(sql: Sql, id: string): Promise<Job | null> {
  const rows = await sql.query<Row>(
    `with c as (
       update jobs set status = 'cancelled', updated_at = now(), finished_at = now(), image = null, context = '', files = null
       where id = $1 and status in ('uploading', 'queued', 'running') returning ${PUBLIC_COLS}, thread_id, turn
     ), keep_inputs as (
       insert into chat_input_parts(job_id, path, part, data)
       select p.job_id, p.path, p.part, p.data from job_inputs p join c on c.id = p.job_id
       where c.thread_id is not null
         and c.turn = (select max(turn) from jobs where thread_id = c.thread_id)
         and exists(select 1 from chat_threads where id = c.thread_id and deleted_at is null)
       on conflict do nothing
     ), d as (delete from job_inputs where job_id in (select id from c))
     select * from c`,
    [id],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** What a bridge can run beyond plain questions; an older bridge sends none and never gets imports. */
export const BRIDGE_FEATURES = ["import", "chat"] as const;

/** Atomically hands the oldest runnable job to this device (or reclaims a stale one). */
export async function claimJob(sql: Sql, deviceId: string, agents: readonly Agent[], features: readonly string[] = []): Promise<ClaimedJob | null> {
  if (!agents.length) return null;
  const rows = await sql.query<Row>(
    `update jobs set status = 'running', claimed_by = $1, claimed_at = now(), updated_at = now(), output = '', error = null
     where id = (
       select j.id from jobs j
       where agent = any($2::text[])
         and (kind = 'ask' or kind = any($4::text[]))
         and (j.thread_id is null or not exists (select 1 from jobs earlier where earlier.thread_id = j.thread_id and earlier.turn < j.turn and earlier.status in ('uploading','queued','running')))
         and (status = 'queued' or (status = 'running' and updated_at < now() - make_interval(secs => $3)))
       order by created_at
       limit 1
       for update skip locked
     )
     returning ${PUBLIC_COLS}, context, image, files`,
    [deviceId, agents, STALE_AFTER_S, features],
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
  // Finishing also deletes the job's uploaded parts, in the same statement.
  const rows = await sql.query<{ status: JobStatus }>(
    `with u as (update jobs set
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
     returning id, status, thread_id, agent, turn, options
     ), session_update as (
       update chat_threads set agent_session = jsonb_build_object('agent', u.agent, 'sessionId', $9::text, 'account', u.options->>'account'), updated_at = now()
       from u where chat_threads.id = u.thread_id and $9::text is not null and u.status = 'done'
     ), keep_inputs as (
       insert into chat_input_parts(job_id, path, part, data)
       select p.job_id, p.path, p.part, p.data from job_inputs p join u on u.id = p.job_id
       where u.thread_id is not null and $5::text is not null
         and u.turn = (select max(turn) from jobs where thread_id = u.thread_id)
         and exists(select 1 from chat_threads where id = u.thread_id and deleted_at is null)
       on conflict do nothing
     ), d as (delete from job_inputs where job_id in (select id from u) and $5::text is not null)
     select status from u`,
    [id, deviceId, u.output ?? null, u.append ?? null, u.status ?? null, u.error ?? null, MAX_OUTPUT, u.files ? JSON.stringify(u.files) : null, u.sessionId ?? null],
  );
  if (rows[0]) return { ok: true, status: rows[0].status };
  const cur = await sql.query<{ status: JobStatus }>(`select status from jobs where id = $1 and claimed_by = $2`, [id, deviceId]);
  return { ok: false, reason: cur[0]?.status === "cancelled" ? "cancelled" : "not_claimed" };
}

/** A 409 carries the job's status, so a client whose last response was lost can tell it already queued. */
export type InputResult = { ok: true; status: JobStatus; received: number; expected: number } | { ok: false; status: 400 | 404 | 409; error: string; jobStatus?: JobStatus };

/**
 * Stores one part of a declared upload. The part must be in the manifest and exactly its expected
 * length. Once every part is in, the job moves from "uploading" to "queued". A part can be sent
 * again (a retry overwrites it).
 */
export async function putJobInput(sql: Sql, id: string, input: z.infer<typeof jobInputSchema>): Promise<InputResult> {
  const job = (await sql.query<{ status: JobStatus; uploads: UploadSpec[] | null }>(`select status, uploads from jobs where id = $1`, [id]))[0];
  if (!job) return { ok: false, status: 404, error: "not found" };
  if (job.status !== "uploading") return { ok: false, status: 409, error: `job is ${job.status}, not uploading`, jobStatus: job.status };
  const spec = (job.uploads ?? []).find((u) => u.path === input.path);
  if (!spec) return { ok: false, status: 400, error: `${input.path} is not one of this job's uploads` };
  if (input.part >= spec.parts) return { ok: false, status: 400, error: `${input.path} has ${spec.parts} part(s)` };
  const want = partLength(spec.size, input.part);
  if (input.data.length !== want) return { ok: false, status: 400, error: `part ${input.part} of ${input.path} must be ${want} characters, got ${input.data.length}` };
  const ins = await sql.query(
    `insert into job_inputs (job_id, path, part, data)
     select $1, $2, $3, $4 where exists (select 1 from jobs where id = $1 and status = 'uploading')
     on conflict (job_id, path, part) do update set data = excluded.data
     returning part`,
    [id, input.path, input.part, input.data],
  );
  if (!ins.length) {
    const now = (await sql.query<{ status: JobStatus }>(`select status from jobs where id = $1`, [id]))[0]?.status;
    return { ok: false, status: 409, error: "job is no longer uploading", jobStatus: now };
  }
  const expected = (job.uploads ?? []).reduce((n, u) => n + u.parts, 0);
  // Separate statement, so it sees this insert and any made in parallel.
  const done = await sql.query<{ status: JobStatus; received: number }>(
    `update jobs set status = case when (select count(*) from job_inputs where job_id = $1) >= $2 then 'queued' else status end, updated_at = now()
     where id = $1 and status = 'uploading'
     returning status, (select count(*)::int from job_inputs where job_id = $1) as received`,
    [id, expected],
  );
  return { ok: true, status: done[0]?.status ?? "queued", received: Number(done[0]?.received ?? expected), expected };
}

/** One part of an upload, for the device that is running the job. */
export async function getJobInput(sql: Sql, id: string, deviceId: string, path: string, part: number): Promise<string | null> {
  const rows = await sql.query<{ data: string }>(
    `select i.data from job_inputs i join jobs j on j.id = i.job_id
     where j.id = $1 and j.claimed_by = $2 and j.status = 'running' and i.path = $3 and i.part = $4`,
    [id, deviceId, path, part],
  );
  return rows[0]?.data ?? null;
}
