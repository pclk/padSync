import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireSession } from '@/server/guard';
import { metadata, pdfError, type PdfRow } from '@/server/attachments';
import { MAX_FILE_BYTES } from '@/lib/uploads';
const input = z.object({ notebookId: z.string().min(1).max(100), name: z.string().min(1).max(255).refine(n => !/[\x00-\x1f]/.test(n)), size: z.number().int().min(5).max(MAX_FILE_BYTES) });
export async function GET(req: NextRequest) {
  const auth = await requireSession(req); if (auth instanceof Response) return auth;
  const notebook = req.nextUrl.searchParams.get('notebookId');
  if (!notebook || notebook.length > 100) return pdfError(400, 'notebookId required');
  await auth.sql.query("delete from lecture_pdfs where owner=$1 and ready=false and created_at < now() - interval '24 hours'", [auth.login.toLowerCase()]);
  const rows = await auth.sql.query<PdfRow>('select id, notebook_id, name, size, ready from lecture_pdfs where owner=$1 and (notebook_id=$2 or id in (select attachment_id from lecture_pdf_notebooks where notebook_id=$2)) and ready=true order by created_at, id', [auth.login.toLowerCase(), notebook]);
  return Response.json({ attachments: rows.map(metadata) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(req: NextRequest) {
  const auth = await requireSession(req); if (auth instanceof Response) return auth;
  const data = input.safeParse(await req.json().catch(() => null));
  if (!data.success) return pdfError(400, 'Invalid PDF metadata or file size');
  const { notebookId, name, size } = data.data;
  const id = randomUUID();
  await auth.sql.query('insert into lecture_pdfs(id,owner,notebook_id,name,size) values($1,$2,$3,$4,$5)', [id,auth.login.toLowerCase(),notebookId,name,size]);
  return Response.json({ attachment: metadata({ id, notebook_id: notebookId, name, size, ready: false }) }, { status: 201 });
}
