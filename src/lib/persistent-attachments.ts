import { PDF_CHUNK_BYTES, type PersistentPdf } from './persistent-attachment-meta';
export type { PersistentPdf } from './persistent-attachment-meta';
export interface ResolvedPdf { meta: PersistentPdf; blob: Blob }
async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 ? 'Sign in to access lecture PDFs.' : response.status === 404 ? 'PDF unavailable. It may have been removed.' : body.error ?? `PDF request failed (${response.status}).`);
  }
  return response;
}
export async function listPersistentPdfs(notebookId: string, signal?: AbortSignal): Promise<PersistentPdf[]> {
  return (await (await checked(await fetch(`/api/attachments?notebookId=${encodeURIComponent(notebookId)}`, { cache: 'no-store', signal }))).json()).attachments;
}
export async function uploadPersistentPdf(notebookId: string, file: File, onProgress?: (sent: number) => void): Promise<PersistentPdf> {
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') throw new Error('Choose a PDF file.');
  const created = await (await checked(await fetch('/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notebookId, name: file.name, size: file.size }) }))).json();
  const meta: PersistentPdf = created.attachment;
  try {
    for (let offset = 0, part = 0; offset < file.size; offset += PDF_CHUNK_BYTES, part++) {
      await checked(await fetch(`/api/attachments/${meta.id}?part=${part}`, { method: 'PUT', body: file.slice(offset, offset + PDF_CHUNK_BYTES) }));
      onProgress?.(Math.min(file.size, offset + PDF_CHUNK_BYTES));
    }
    await checked(await fetch(`/api/attachments/${meta.id}`, { method: 'POST' }));
    return meta;
  } catch (error) {
    await fetch(`/api/attachments/${meta.id}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}
export async function getPersistentPdfBlob(meta: PersistentPdf, signal?: AbortSignal): Promise<Blob> {
  const parts: Blob[] = [];
  for (let part = 0; part < Math.ceil(meta.size / PDF_CHUNK_BYTES); part++) {
    const blob = await (await checked(await fetch(`/api/attachments/${encodeURIComponent(meta.id)}?part=${part}`, { cache: 'no-store', signal }))).blob();
    if (blob.size !== Math.min(PDF_CHUNK_BYTES, meta.size - part * PDF_CHUNK_BYTES)) throw new Error('PDF unavailable: stored size mismatch.');
    parts.push(blob);
  }
  return new Blob(parts, { type: 'application/pdf' });
}
export async function deletePersistentPdf(id: string) {
  await checked(await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function associatePersistentPdf(id: string, notebookId: string) {
  await checked(await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notebookId }) }));
}
