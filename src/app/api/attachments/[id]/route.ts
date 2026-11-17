import type { NextRequest } from 'next/server';
import { requireSession } from '@/server/guard';
import { ownedPdf, metadata, pdfError } from '@/server/attachments';
import { PDF_CHUNK_BYTES } from '@/lib/persistent-attachment-meta';
type Context = { params: Promise<{ id: string }> };
async function handle(req: NextRequest, ctx: Context) {
  const auth = await requireSession(req); if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const row = await ownedPdf(auth.sql, auth.login, id); if (!row) return pdfError(404, 'PDF unavailable');
  const { sql } = auth;
  if (req.method === 'PATCH') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.notebookId !== 'string' || !body.notebookId.length || body.notebookId.length > 100) return pdfError(400, 'Invalid notebook');
    await sql.query('insert into lecture_pdf_notebooks(attachment_id, notebook_id) values($1,$2) on conflict do nothing', [id, body.notebookId]);
    return Response.json({ associated: true });
  }
  if (req.method === 'DELETE') {
    await sql.query('delete from lecture_pdfs where id=$1 and owner=$2', [id, auth.login.toLowerCase()]);
    return new Response(null, { status: 204 });
  }
  if (req.method === 'POST') {
    const result = await sql.query(`update lecture_pdfs p set ready=true where id=$1 and owner=$2 and (select count(*) from lecture_pdf_parts where attachment_id=p.id)=$3 returning id`, [id,auth.login.toLowerCase(),Math.ceil(row.size/PDF_CHUNK_BYTES)]);
    return result.length ? Response.json({ attachment: metadata(row) }) : pdfError(409, 'PDF upload incomplete');
  }
  const raw = req.nextUrl.searchParams.get('part');
  const part = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
  if (!Number.isSafeInteger(part) || part < 0 || part >= Math.ceil(row.size/PDF_CHUNK_BYTES)) return pdfError(400, 'Invalid part');
  if (req.method === 'GET') {
    if (!row.ready) return pdfError(409, 'PDF upload incomplete');
    const data = (await sql.query<{ data: string }>('select data from lecture_pdf_parts where attachment_id=$1 and part=$2', [id, part]))[0];
    if (!data) return pdfError(404, 'PDF unavailable');
    return new Response(Buffer.from(data.data, 'base64'), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (row.ready) return pdfError(409, 'PDF already finalized');
  const expected = Math.min(PDF_CHUNK_BYTES, row.size - part * PDF_CHUNK_BYTES);
  if (Number(req.headers.get('content-length')) > expected) return pdfError(413, 'Part too large');
  // Bound reading even for chunked requests without a Content-Length.
  const reader = req.body?.getReader(); if (!reader) return pdfError(400, 'Missing PDF bytes');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > expected) { await reader.cancel(); return pdfError(413, 'Part too large'); } chunks.push(next.value); }
  const bytes = Buffer.concat(chunks);
  if (length !== expected || (part === 0 && bytes.subarray(0,5).toString() !== '%PDF-')) return pdfError(400, 'Invalid PDF bytes or part length');
  await sql.query(`with locked as (select id from lecture_pdfs where id=$1 and ready=false for update) insert into lecture_pdf_parts(attachment_id,part,data) select id,$2,$3 from locked on conflict(attachment_id,part) do update set data=excluded.data`, [id,part,bytes.toString('base64')]);
  return Response.json({ received: part });
}
export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;

export const PATCH = handle;
