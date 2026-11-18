import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListPartsCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireSession } from '@/server/guard';
import { pdfError } from '@/server/attachments';
import { ownedDocument, pdfKey, pdfMetadata, pdfStorage, sweepPdfsLater } from '@/server/pdf-storage';
import { PDF_PART_BYTES, pdfSignature } from '@/lib/pdf-meta';
const reply = (data: unknown) => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
export async function GET(req: NextRequest) {
  const auth = await requireSession(req); if (auth instanceof Response) return auth;
  const storage = pdfStorage(); if (!storage) return pdfError(503, 'PDF object storage is not configured. Use Local only or configure Neon storage.');
  sweepPdfsLater(auth.sql, auth.login, storage);
  const row = await ownedDocument(auth.sql, auth.login, req.nextUrl.searchParams.get('id') ?? '');
  if (!row?.ready) return pdfError(404, 'PDF not found');
  return reply({ sha256: row.sha256, size: row.size, url: await getSignedUrl(storage.s3, new GetObjectCommand({ Bucket: storage.bucket, Key: row.object_key }), { expiresIn: 300 }) });
}
export async function POST(req: NextRequest) {
  const auth = await requireSession(req); if (auth instanceof Response) return auth;
  const storage = pdfStorage(); if (!storage) return pdfError(503, 'PDF object storage is not configured. Use Local only or configure Neon storage.');
  const body = await req.json().catch(() => null);
  const { s3, bucket: Bucket } = storage;
  try {
    // The library asks on open, so PDFs of notebooks deleted elsewhere do not linger.
    if (body?.action === 'sweep') { sweepPdfsLater(auth.sql, auth.login, storage); return reply({ sweeping: true }); }
    if (body?.action === 'create') {
      const parsed = pdfMetadata.safeParse(body); if (!parsed.success) return pdfError(400, 'Invalid PDF metadata (maximum 100 MiB, 2000 pages)');
      sweepPdfsLater(auth.sql, auth.login, storage);
      const d = parsed.data, id = randomUUID(), Key = pdfKey(auth.login, id);
      const upload = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: 'application/pdf' }));
      if (!upload.UploadId) throw new Error('No upload id');
      try { await auth.sql.query('insert into notebook_pdfs(id,owner,notebook_id,object_key,name,size,page_count,sha256,upload_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id,auth.login.toLowerCase(),d.notebookId,Key,d.name,d.size,d.pageCount,d.sha256,upload.UploadId]); }
      catch (e) { await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId: upload.UploadId })); throw e; }
      const urls = await Promise.all(Array.from({ length: Math.ceil(d.size / PDF_PART_BYTES) }, (_, i) => getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId: upload.UploadId, PartNumber: i + 1, ContentLength: Math.min(PDF_PART_BYTES, d.size - i * PDF_PART_BYTES) }), { expiresIn: 3600 })));
      return reply({ id, urls });
    }
    const parsed = z.object({ action: z.enum(['complete','abort']), id: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return pdfError(400, 'Invalid PDF operation');
    const row = await ownedDocument(auth.sql, auth.login, parsed.data.id);
    if (!row) return pdfError(404, 'PDF not found');
    if (row.ready) return parsed.data.action === 'complete' ? reply({ ready: true }) : pdfError(409, 'PDF already finalized');
    const target = { Bucket, Key: row.object_key, UploadId: row.upload_id };
    if (parsed.data.action === 'abort') {
      try { await s3.send(new AbortMultipartUploadCommand(target)); }
      catch (e) { if (!(e instanceof Error) || e.name !== 'NoSuchUpload') throw e; }
      await s3.send(new DeleteObjectCommand({ Bucket, Key: row.object_key }));
      await auth.sql.query('delete from notebook_pdfs where id=$1 and owner=$2 and ready=false', [row.id,auth.login.toLowerCase()]);
      return reply({ cancelled: true });
    }
    // A retry after S3 completion can finish metadata validation without re-completing the upload.
    let head;
    try { head = await s3.send(new HeadObjectCommand(target)); } catch { /* not completed */ }
    if (!head) {
      const parts = await s3.send(new ListPartsCommand(target));
      const expected = Math.ceil(row.size / PDF_PART_BYTES);
      if (parts.IsTruncated || parts.Parts?.length !== expected || parts.Parts.some((p,i) => p.PartNumber !== i + 1 || p.Size !== Math.min(PDF_PART_BYTES,row.size-i*PDF_PART_BYTES))) return pdfError(400, 'Incomplete PDF upload');
      await s3.send(new CompleteMultipartUploadCommand({ ...target, MultipartUpload: { Parts: parts.Parts.map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag })) } }));
      head = await s3.send(new HeadObjectCommand(target));
    }
    const signature = await s3.send(new GetObjectCommand({ ...target, Range: 'bytes=0-4' }));
    if (head.ContentLength !== row.size || !pdfSignature(await signature.Body!.transformToByteArray())) return pdfError(400, 'Invalid PDF signature or size');
    await auth.sql.query('update notebook_pdfs set ready=true where id=$1 and owner=$2', [row.id,auth.login.toLowerCase()]);
    return reply({ ready: true });
  } catch { return pdfError(502, 'PDF storage request failed. Check storage configuration and retry.'); }
}
