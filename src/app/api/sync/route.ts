import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/guard";
import { syncServerTiming } from "@/server/sync-timing";
import { sweepPdfsLater } from "@/server/pdf-storage";

// One endpoint does push and pull. Writes are last-writer-wins per entity on the hlc; every
// accepted write takes a new seq, and clients pull "everything after my cursor".
//
// Entity writers take one transaction-scoped lock before allocating sequence numbers.
// This keeps committed sequence order safe for the pull cursor across devices/instances.

const PULL_LIMIT = 200; // keeps responses under Vercel's 4.5 MB body limit
/** Pasted images ride in their rows, so a page also stops once its data passes this size. */
const PULL_BYTES = 3_000_000;

const entity = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["notebook", "section", "stroke", "textbox", "image", "presence", "folder"]),
  notebookId: z.string().max(100),
  parentId: z.string().max(100),
  data: z.record(z.string(), z.unknown()),
  hlc: z.string().min(1).max(100),
  deleted: z.union([z.literal(0), z.literal(1)]),
});

const event = z.object({
  id: z.string().min(1).max(100),
  notebookId: z.string().max(100),
  sectionId: z.string().max(100).nullable(),
  type: z.string().max(60),
  t: z.number(),
  device: z.string().max(100),
  data: z.record(z.string(), z.unknown()),
});

const body = z.object({
  since: z.number().int().nonnegative(),
  changes: z.array(entity).max(1000),
  events: z.array(event).max(2000),
});

// Postgres jsonb rejects \u0000 and unpaired surrogates (PDF text extraction yields both), and one
// bad string fails the whole push, so the client retries the same batch forever. Strip them here.
function pgSafe(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\0/g, "").toWellFormed();
  if (Array.isArray(v)) return v.map(pgSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [pgSafe(k) as string, pgSafe(x)]));
  return v;
}

interface Row {
  id: string;
  kind: string;
  notebook_id: string;
  parent_id: string;
  data: Record<string, unknown>;
  hlc: string;
  deleted: boolean;
  seq: string;
  /** Pull only: rows after the cursor within the row limit, before the size limit cut them. */
  total?: string;
}

export async function POST(req: NextRequest) {
  const timing = syncServerTiming(req.headers.get("x-padsync-debug") === "1");
  const auth = await requireSession(req);
  timing.mark("auth");
  if (auth instanceof Response) return timing.respond(auth);
  const { sql } = auth;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const { since, changes, events } = parsed.data;
  timing.mark("parse");

  // One row per id (the newest), or the upsert fails with "cannot affect row a second time".
  const latest = new Map<string, (typeof changes)[number]>();
  for (const c of changes) {
    const prev = latest.get(c.id);
    if (!prev || c.hlc > prev.hlc) latest.set(c.id, c);
  }
  const pushed = [...latest.values()];
  const sentHlc = new Map(pushed.map(c => [c.id, c.hlc]));
  const sentVersions = JSON.stringify(Object.fromEntries(sentHlc));

  // The lock is evaluated before INSERT defaults or conflict updates allocate seq.
  // It is held until this statement's implicit transaction commits.
  let lost: Row[] = [];
  if (pushed.length) {
    const rows = pushed.map((c) => ({ id: c.id, kind: c.kind, notebook_id: c.notebookId, parent_id: c.parentId, data: pgSafe(c.data), hlc: c.hlc, deleted: c.deleted === 1 }));
    await sql.query(
      `with locked as materialized (select pg_advisory_xact_lock(72419381)), x as (
         select * from jsonb_to_recordset($1::jsonb)
           as x(id text, kind text, notebook_id text, parent_id text, data jsonb, hlc text, deleted boolean)
       )
       insert into entities (id, kind, notebook_id, parent_id, data, hlc, deleted)
       select x.id, x.kind, x.notebook_id, x.parent_id, x.data, x.hlc, x.deleted from locked cross join x
       on conflict (id) do update set
         kind = excluded.kind, notebook_id = excluded.notebook_id, parent_id = excluded.parent_id,
         data = excluded.data, hlc = excluded.hlc, deleted = excluded.deleted,
         seq = nextval('entity_seq'), updated_at = now()
       where entities.hlc collate "C" < excluded.hlc collate "C"`,
      [JSON.stringify(rows)],
    );
    timing.mark("write");
    // Fresh statement snapshot sees a concurrent winner that ON CONFLICT waited for.
    // Return it even when its sequence is behind the caller's existing cursor.
    // Filter in Postgres so successful pushes do not download their JSON again.
    const authoritative = await sql.query<Row>(
      `select id, kind, notebook_id, parent_id, data, hlc, deleted, seq from entities
       where id = any($1::text[]) and hlc collate "C" > ($2::jsonb ->> id) collate "C"`,
      [pushed.map(c => c.id), sentVersions],
    );
    lost = authoritative;
    timing.mark("conflicts");
    // A notebook tombstone frees its stored PDF; the sweep removes the object after the response.
    if (pushed.some((c) => c.kind === "notebook" && c.deleted === 1)) sweepPdfsLater(sql, auth.login);
  }

  if (events.length) {
    const rows = events.map((e) => ({ id: e.id, notebook_id: e.notebookId, section_id: e.sectionId, type: e.type, t: e.t, device: e.device, data: pgSafe(e.data) }));
    await sql.query(
      `insert into events (id, notebook_id, section_id, type, t, device, data)
       select id, notebook_id, section_id, type, t, device, data
       from jsonb_to_recordset($1::jsonb) as x(id text, notebook_id text, section_id text, type text, t bigint, device text, data jsonb)
       on conflict (id) do nothing`,
      [JSON.stringify(rows)],
    );
  }

  timing.mark("events");
  // Keep own rows in the page for cursor/limit accounting, but avoid transferring their
  // potentially large data from Neon. The version filter below removes these placeholders.
  // The page always holds its first row, then stops before its data passes PULL_BYTES.
  const pulled = (await sql.query(
    `select id, kind, notebook_id, parent_id, data, hlc, deleted, seq, total from (
       select page.*, sum(coalesce(octet_length(data::text), 0)) over (order by seq) as running,
         row_number() over (order by seq) as n, count(*) over () as total
       from (
         select id, kind, notebook_id, parent_id,
           case when hlc = ($3::jsonb ->> id) then null else data end as data,
           hlc, deleted, seq from entities where seq > $1 order by seq limit $2
       ) page
     ) sized where n = 1 or running <= $4 order by seq`,
    [since, PULL_LIMIT + 1, sentVersions, PULL_BYTES],
  )) as Row[];
  timing.mark("pull");
  const page = pulled.slice(0, PULL_LIMIT);
  const more = page.length < Number(pulled[0]?.total ?? 0);

  // The caller already has what it just wrote, so those rows are not echoed back; the cursor
  // still moves past them.
  const out = page.filter((r) => sentHlc.get(r.id) !== r.hlc);
  const inPage = new Set(out.map((r) => r.id));
  for (const r of lost) if (!inPage.has(r.id)) out.push(r);

  const response = Response.json({
    changes: out.map((r) => ({ id: r.id, kind: r.kind, notebookId: r.notebook_id, parentId: r.parent_id, data: r.data, hlc: r.hlc, deleted: r.deleted ? 1 : 0 })),
    cursor: page.length ? Number(page[page.length - 1].seq) : since,
    more,
  });
  timing.mark("serialize");
  return timing.respond(response);
}
