import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/server/guard";

// One endpoint does push and pull. Writes are last-writer-wins per entity on the hlc; every
// accepted write takes a new seq, and clients pull "everything after my cursor".
//
// Known gap: two concurrent requests can commit seqs out of order, so a pull may briefly skip a
// row. With one person on two devices this is rare; the next write to that entity heals it.

const PULL_LIMIT = 200; // keeps responses under Vercel's 4.5 MB body limit

const entity = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["notebook", "section", "stroke", "textbox", "presence"]),
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

interface Row {
  id: string;
  kind: string;
  notebook_id: string;
  parent_id: string;
  data: Record<string, unknown>;
  hlc: string;
  deleted: boolean;
  seq: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) return auth;
  const { sql } = auth;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.slice(0, 5) }, { status: 400 });
  const { since, changes, events } = parsed.data;

  // One row per id (the newest), or the upsert fails with "cannot affect row a second time".
  const latest = new Map<string, (typeof changes)[number]>();
  for (const c of changes) {
    const prev = latest.get(c.id);
    if (!prev || c.hlc > prev.hlc) latest.set(c.id, c);
  }
  const pushed = [...latest.values()];

  // A write that loses to a newer server version gets that version back, even if the caller's
  // cursor is already past it, so the two never stay diverged. The outer select reads the snapshot
  // from before the upsert, which is exactly where those losers show up. hlc compares bytewise
  // (collate "C"), the same order the client's string comparison uses.
  let lost: Row[] = [];
  if (pushed.length) {
    const rows = pushed.map((c) => ({ id: c.id, kind: c.kind, notebook_id: c.notebookId, parent_id: c.parentId, data: c.data, hlc: c.hlc, deleted: c.deleted === 1 }));
    lost = (await sql.query(
      `with x as (
         select * from jsonb_to_recordset($1::jsonb)
           as x(id text, kind text, notebook_id text, parent_id text, data jsonb, hlc text, deleted boolean)
       ), up as (
         insert into entities (id, kind, notebook_id, parent_id, data, hlc, deleted)
         select id, kind, notebook_id, parent_id, data, hlc, deleted from x
         on conflict (id) do update set
           kind = excluded.kind, notebook_id = excluded.notebook_id, parent_id = excluded.parent_id,
           data = excluded.data, hlc = excluded.hlc, deleted = excluded.deleted,
           seq = nextval('entity_seq'), updated_at = now()
         where entities.hlc collate "C" < excluded.hlc collate "C"
       )
       select e.id, e.kind, e.notebook_id, e.parent_id, e.data, e.hlc, e.deleted, e.seq
       from entities e join x on x.id = e.id
       where e.hlc collate "C" > x.hlc collate "C"`,
      [JSON.stringify(rows)],
    )) as Row[];
  }

  if (events.length) {
    const rows = events.map((e) => ({ id: e.id, notebook_id: e.notebookId, section_id: e.sectionId, type: e.type, t: e.t, device: e.device, data: e.data }));
    await sql.query(
      `insert into events (id, notebook_id, section_id, type, t, device, data)
       select id, notebook_id, section_id, type, t, device, data
       from jsonb_to_recordset($1::jsonb) as x(id text, notebook_id text, section_id text, type text, t bigint, device text, data jsonb)
       on conflict (id) do nothing`,
      [JSON.stringify(rows)],
    );
  }

  const pulled = (await sql.query(
    `select id, kind, notebook_id, parent_id, data, hlc, deleted, seq from entities where seq > $1 order by seq limit $2`,
    [since, PULL_LIMIT + 1],
  )) as Row[];
  const more = pulled.length > PULL_LIMIT;
  const page = more ? pulled.slice(0, PULL_LIMIT) : pulled;

  // The caller already has what it just wrote, so those rows are not echoed back; the cursor
  // still moves past them.
  const sentHlc = new Map(pushed.map((c) => [c.id, c.hlc]));
  const out = page.filter((r) => sentHlc.get(r.id) !== r.hlc);
  const inPage = new Set(out.map((r) => r.id));
  for (const r of lost) if (!inPage.has(r.id)) out.push(r);

  return Response.json({
    changes: out.map((r) => ({ id: r.id, kind: r.kind, notebookId: r.notebook_id, parentId: r.parent_id, data: r.data, hlc: r.hlc, deleted: r.deleted ? 1 : 0 })),
    cursor: page.length ? Number(page[page.length - 1].seq) : since,
    more,
  });
}
