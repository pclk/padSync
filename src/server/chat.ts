import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_UPLOAD_FILES, MAX_TOTAL_CHARS } from "@/lib/uploads";
import type { Sql } from "./db";
import { jobOptionsSchema } from "./jobs";
import type { ThreadSummary, Turn } from "@/lib/chat-types";
export const threadSchema = z.object({
  notebookId: z.string().max(100).default(""),
  title: z.string().max(200).default(""),
  agent: z.enum(["claude", "codex"]),
  options: jobOptionsSchema.default({}),
});
export const patchSchema = threadSchema
  .omit({ notebookId: true })
  .partial()
  .extend({ pinned: z.boolean().optional(), archived: z.boolean().optional() });
const id = () => "chat_" + randomBytes(12).toString("hex");
const cols = `t.id, t.notebook_id as "notebookId", t.title, t.agent, t.options, t.pinned, t.archived,
 t.created_at as "createdAt", t.updated_at as "updatedAt", t.last_message_at as "lastMessageAt", t.forked_from as "forkedFrom",
 (select count(*)::int from jobs j where j.thread_id=t.id) as "turnCount",
 (select status from jobs j where j.thread_id=t.id order by turn desc limit 1) as "lastStatus",
 coalesce((select left(case when output='' then question else output end,160) from jobs j where j.thread_id=t.id order by turn desc limit 1),'') as preview`;
export async function listThreads(
  sql: Sql,
  f: { notebookId?: string; q?: string; archived?: boolean } = {},
) {
  return sql.query<ThreadSummary>(
    `select ${cols} from chat_threads t where deleted_at is null and archived=$1 and ($2::text is null or notebook_id=$2) and ($3='' or title ilike '%'||$3||'%' or exists(select 1 from jobs j where j.thread_id=t.id and (question ilike '%'||$3||'%' or output ilike '%'||$3||'%'))) order by pinned desc, last_message_at desc nulls last, created_at desc limit 50`,
    [f.archived ?? false, f.notebookId ?? null, f.q ?? ""],
  );
}
export async function getThread(sql: Sql, threadId: string) {
  return (
    (
      await sql.query<ThreadSummary>(
        `select ${cols} from chat_threads t where id=$1 and deleted_at is null`,
        [threadId],
      )
    )[0] ?? null
  );
}
export async function createThread(
  sql: Sql,
  input: z.infer<typeof threadSchema>,
) {
  const key = id();
  await sql.query(
    `insert into chat_threads(id,notebook_id,title,agent,options) values($1,$2,$3,$4,$5::jsonb)`,
    [
      key,
      input.notebookId,
      input.title,
      input.agent,
      JSON.stringify(input.options),
    ],
  );
  return getThread(sql, key);
}
export async function patchThread(
  sql: Sql,
  key: string,
  input: z.infer<typeof patchSchema>,
) {
  await sql.query(
    `update chat_threads set title=coalesce($2,title), pinned=coalesce($3,pinned), archived=coalesce($4,archived), agent=coalesce($5,agent), options=coalesce($6::jsonb,options),updated_at=now() where id=$1 and deleted_at is null`,
    [
      key,
      input.title ?? null,
      input.pinned ?? null,
      input.archived ?? null,
      input.agent ?? null,
      input.options ? JSON.stringify(input.options) : null,
    ],
  );
  return getThread(sql, key);
}
export async function deleteThread(sql: Sql, key: string) {
  await sql.query(
    `with t as (
       update chat_threads set deleted_at = now(), updated_at = now()
       where id = $1 returning id
     ), j as (
       update jobs set status = 'cancelled', finished_at = now(), updated_at = now(),
         files = null, image = null, context = ''
       where thread_id in (select id from t) and status in ('uploading','queued','running')
       returning id
     ) delete from job_inputs where job_id in (select id from j)`,
    [key],
  );
  await pruneReplay(sql, key, true);
}
export async function getTurns(
  sql: Sql,
  key: string,
  since?: string,
  from = "",
  jobId?: string,
) {
  const offsets: Record<string, number> = {};
  for (const pair of from.split(",")) {
    const [n, len] = pair.split(":").map(Number);
    if (Number.isInteger(n) && Number.isInteger(len) && len >= 0)
      offsets[n] = len;
  }
  return sql.query<Turn>(
    `select id as "jobId", turn,question,chat_context as context,attachments,agent,options,status,
 substring(output from (case when status='running' then least(length(output),coalesce(($3::jsonb->>turn::text)::int,0)) else 0 end)+1) as output,
 case when status='running' then least(length(output),coalesce(($3::jsonb->>turn::text)::int,0)) else 0 end as "outputOffset",
 error,created_at as "createdAt",updated_at as "updatedAt",finished_at as "finishedAt",
 coalesce((select jsonb_agg(jsonb_build_object('path',f->>'path','mime',f->>'mime','size',length(coalesce(f->>'text',f->>'base64','')))) from jsonb_array_elements(result_files) f),'[]'::jsonb) as "resultFiles"
 from jobs where thread_id=$1 and ($4::text is null or id=$4) and ($2::timestamptz is null or updated_at>$2::timestamptz) order by turn`,
    [key, since ?? null, JSON.stringify(offsets), jobId ?? null],
  );
}
export const newTurnSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  files: z.array(z.unknown()).default([]),
  uploads: z.array(z.unknown()).default([]),
  context: z
    .object({
      scope: z.enum(["none", "section", "sections", "selection", "notebook"]),
      sectionIds: z.array(z.string()),
      label: z.string(),
      bytes: z.number().nonnegative(),
      tokens: z.number().nonnegative(),
    })
    .optional(),
  options: jobOptionsSchema.optional(),
});
export async function createTurn(
  sql: Sql,
  key: string,
  raw: z.infer<typeof newTurnSchema>,
  expectedLastTurn?: number,
) {
  const { jobFilesSchema, uploadSchema } = await import("./jobs");
  const files = jobFilesSchema.parse(raw.files);
  const uploads = z
    .array(uploadSchema)
    .max(MAX_UPLOAD_FILES)
    .parse(raw.uploads);
  if (
    new Set([...files, ...uploads].map((f) => f.path.toLowerCase())).size !==
      files.length + uploads.length ||
    uploads.reduce((n, u) => n + u.size, 0) > MAX_TOTAL_CHARS
  )
    throw new Error("Invalid attachments");
  const meta = [
    ...files.map((f) => ({
      path: f.path,
      mime: f.mime,
      size: (f.text ?? f.base64 ?? "").length,
    })),
    ...uploads,
  ];
  const rows = await sql.query<{ id: string }>(
    `with t as (
       update chat_threads set next_turn = next_turn + 1, updated_at = now(), last_message_at = now(),
         title = case when next_turn = 0 and title = '' then left(split_part($3,E'\\n',1),60) else title end
       where id = $1 and deleted_at is null and ($10::int is null or next_turn = $10)
       returning *
     ) insert into jobs(id, kind, thread_id, turn, notebook_id, agent, question, options,
         files, chat_files, uploads, status, chat_context, attachments)
       select $2, 'chat', id, next_turn, notebook_id, agent, $3, coalesce($4::jsonb,options),
         $5::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::jsonb from t returning id`,
    [
      key,
      id(),
      raw.question,
      raw.options ? JSON.stringify(raw.options) : null,
      JSON.stringify(files),
      JSON.stringify(uploads),
      uploads.length ? "uploading" : "queued",
      JSON.stringify(raw.context ?? null),
      JSON.stringify(meta),
      expectedLastTurn ?? null,
    ],
  );
  if (!rows.length) return null;
  await pruneReplay(sql, key);
  return (await getTurns(sql, key, undefined, "", rows[0].id))[0];
}
export async function regenerate(sql: Sql, key: string, n: number) {
  const rows = await sql.query<{
    question: string;
    files: unknown[];
    uploads: unknown[];
    context?: z.infer<typeof newTurnSchema>["context"];
    options: z.infer<typeof jobOptionsSchema>;
  }>(
    `select question,chat_files as files,uploads,options,chat_context as context from jobs where thread_id=$1 and turn=$2 and turn=(select max(turn) from jobs where thread_id=$1)`,
    [key, n],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const parts = await replayParts(sql, key, n);
  const created = await createTurn(
    sql,
    key,
    {
      question: r.question,
      files: r.files ?? [],
      uploads: r.uploads ?? [],
      options: r.options,
      context: r.context ?? undefined,
    },
    n,
  );
  if (created && r.uploads?.length) {
    await copyParts(sql, created.jobId, parts);
    await sql.query(
      `update jobs set status='queued' where id=$1 and (select count(*) from job_inputs where job_id=$1)=(select coalesce(sum((u->>'parts')::int),0) from jsonb_array_elements(uploads) u)`,
      [created.jobId],
    );
  }
  return created
    ? (await getTurns(sql, key, undefined, "", created.jobId))[0]
    : null;
}
export async function forkThread(
  sql: Sql,
  key: string,
  n: number,
  title?: string,
) {
  const key2 = id();
  await sql.query(
    `with t as (insert into chat_threads(id,notebook_id,title,agent,options,forked_from,next_turn) select $2,notebook_id,coalesce($4,title),agent,options,jsonb_build_object('threadId',id,'turn',$3::int),coalesce((select max(turn) from jobs where thread_id=$1 and turn<=$3 and status='done'),0) from chat_threads where id=$1 and deleted_at is null returning id) insert into jobs(id,kind,thread_id,turn,notebook_id,agent,question,options,status,output,chat_context,attachments,result_files,finished_at) select $2||'_'||turn,'chat',t.id,turn,notebook_id,agent,question,options,'done',output,chat_context,attachments,result_files,finished_at from jobs cross join t where thread_id=$1 and turn<=$3 and status='done'`,
    [key, key2, n, title ?? null],
  );
  return getThread(sql, key2);
}
export async function chatJobContext(sql: Sql, jobId: string) {
  const rows = await sql.query<{ thread_id: string; turn: number }>(
    `select thread_id,turn from jobs where id=$1`,
    [jobId],
  );
  const j = rows[0];
  if (!j?.thread_id) return {};
  const thread = (
    await sql.query(
      `select agent,agent_session from chat_threads where id=$1`,
      [j.thread_id],
    )
  )[0];
  const history = await sql.query(
    `select question,output from jobs where thread_id=$1 and turn<$2 and status='done' order by turn`,
    [j.thread_id, j.turn],
  );
  return { thread, history };
}

/** Active jobs keep operational inputs; only the latest turn keeps a replay copy. */
async function pruneReplay(sql: Sql, key: string, deleted = false) {
  await sql.query(
    `update jobs set chat_files = null
    where thread_id = $1 and chat_files is not null and ($2 or turn <(select max(turn) from jobs where thread_id = $1))`,
    [key, deleted],
  );
  await sql.query(
    `delete from chat_input_parts where job_id in (
    select id from jobs where thread_id = $1
      and ($2 or turn < (select max(turn) from jobs where thread_id = $1)))`,
    [key, deleted],
  );
  if (deleted)
    await sql.query(
      `delete from job_inputs where job_id in (select id from jobs where thread_id = $1)`,
      [key],
    );
}
type ReplayPart = { path: string; part: number; data: string };
async function replayParts(sql: Sql, key: string, n: number) {
  return sql.query<ReplayPart>(
    `select distinct p.path, p.part, p.data
    from (select * from chat_input_parts union all select * from job_inputs) p
    join jobs j on j.id = p.job_id where j.thread_id = $1 and j.turn = $2`,
    [key, n],
  );
}
async function copyParts(sql: Sql, jobId: string, parts: ReplayPart[]) {
  for (const p of parts)
    await sql.query(
      `insert into job_inputs(job_id,path,part,data)
    values($1,$2,$3,$4) on conflict do nothing`,
      [jobId, p.path, p.part, p.data],
    );
}
export async function editTurn(
  sql: Sql,
  key: string,
  n: number,
  question: string,
) {
  const source = (
    await sql.query<{
      chat_files: z.infer<typeof newTurnSchema>["files"] | null;
      uploads: { parts: number }[] | null;
      attachments: unknown[];
      chat_context: z.infer<typeof newTurnSchema>["context"];
      options: z.infer<typeof jobOptionsSchema>;
    }>(
      `select chat_files, uploads, attachments, chat_context, options from jobs
    where thread_id=$1 and turn=$2`,
      [key, n],
    )
  )[0];
  if (!source || !(await getThread(sql, key))) return null;
  const parts = await replayParts(sql, key, n);
  if (
    (source.chat_files === null && source.attachments.length > 0) ||
    parts.length !== (source.uploads ?? []).reduce((sum, u) => sum + u.parts, 0)
  )
    throw new Error(
      "Original inputs are no longer available. Re-attach the files and rebuild the notebook context before resending.",
    );
  const fork = await forkThread(sql, key, n - 1);
  if (!fork) return null;
  const next = await createTurn(sql, fork.id, {
    question,
    files: source.chat_files ?? [],
    uploads: source.uploads ?? [],
    context: source.chat_context ?? undefined,
    options: source.options,
  });
  if (next && parts.length) {
    await copyParts(sql, next.jobId, parts);
    await sql.query(`update jobs set status='queued' where id=$1`, [
      next.jobId,
    ]);
  }
  return getThread(sql, fork.id);
}
