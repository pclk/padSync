import 'server-only';
import { after } from 'next/server';
import { createHash } from 'node:crypto';
import { AbortMultipartUploadCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Sql } from './db';
export function pdfKey(owner: string, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid document id');
  return `pdfs/${createHash('sha256').update(owner.toLowerCase()).digest('hex')}/${id}.pdf`;
}
export function pdfStorage() {
  const { AWS_ENDPOINT_URL_S3: endpoint, AWS_REGION: region, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, PDF_STORAGE_BUCKET: bucket } = process.env;
  return endpoint && region && accessKeyId && secretAccessKey && bucket ? { bucket, s3: new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }) } : null;
}
export interface StoredPdf { id: string; owner: string; object_key: string; size: number; sha256: string; upload_id: string; ready: boolean }
export async function ownedDocument(sql: Sql, owner: string, id: string) {
  const row = (await sql.query<StoredPdf>('select * from notebook_pdfs where id=$1 and owner=$2', [id, owner.toLowerCase()]))[0];
  return row && row.object_key === pdfKey(owner, row.id) ? row : undefined;
}
type Storage = NonNullable<ReturnType<typeof pdfStorage>>;
/** PDFs nobody can reach: uploads abandoned for a day, notebooks deleted, or a notebook that never synced in 30 days. */
export async function sweepPdfs(sql: Sql, owner: string, { s3, bucket: Bucket }: Storage, limit = 20) {
  const rows = await sql.query<StoredPdf>(
    `select p.* from notebook_pdfs p where p.owner=$1 and (
       (not p.ready and p.created_at < now() - interval '1 day')
       or exists (select 1 from entities e where e.id=p.notebook_id and e.kind='notebook' and e.deleted)
       or (p.created_at < now() - interval '30 days' and not exists (select 1 from entities e where e.id=p.notebook_id))
     ) order by p.created_at limit $2`, [owner.toLowerCase(), limit]);
  for (const row of rows) {
    if (row.object_key !== pdfKey(owner, row.id)) continue;
    if (!row.ready) {
      try { await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: row.object_key, UploadId: row.upload_id })); }
      catch (e) { if (!(e instanceof Error) || e.name !== 'NoSuchUpload') throw e; }
    }
    await s3.send(new DeleteObjectCommand({ Bucket, Key: row.object_key }));
    await sql.query('delete from notebook_pdfs where id=$1 and owner=$2', [row.id, owner.toLowerCase()]);
  }
  return rows.length;
}
// Cleanup runs after the response; outside a request scope (tests) it is skipped.
export function sweepPdfsLater(sql: Sql, owner: string, storage: Storage | null = pdfStorage()) {
  if (!storage) return;
  try { after(() => sweepPdfs(sql, owner, storage).catch(e => console.warn('PDF sweep failed', e))); } catch { /* no request scope */ }
}
