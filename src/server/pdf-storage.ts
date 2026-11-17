import 'server-only';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
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
