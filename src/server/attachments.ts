import 'server-only';
import type { Sql } from './db';
import type { PersistentPdf } from '@/lib/persistent-attachment-meta';
export interface PdfRow { id: string; notebook_id: string; name: string; size: number; ready: boolean }
export const metadata = (r: PdfRow): PersistentPdf => ({ id: r.id, persistentId: r.id, notebookId: r.notebook_id, name: r.name, sourceFilename: r.name, size: r.size, mime: 'application/pdf', kind: 'pdf' });
export async function ownedPdf(sql: Sql, owner: string, id: string) {
  return (await sql.query<PdfRow>('select id, notebook_id, name, size, ready from lecture_pdfs where id=$1 and owner=$2', [id, owner.toLowerCase()]))[0];
}
export const pdfError = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
