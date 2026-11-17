import { db, getMeta, setMeta } from './db';
import { PAGE_WIDTH } from './types';
import { pdfSignature, type PdfPage } from './pdf-meta';
import type { PDFDocumentProxy } from 'pdfjs-dist';
let engine: Promise<typeof import('pdfjs-dist')> | undefined;
export function pdfEngine() {
  return engine ??= import('pdfjs-dist').then(pdf => { pdf.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString(); return pdf; });
}
export const cachePdf = (id: string, blob: Blob) => setMeta(`pdf-bytes:${id}`, blob);
const documents = new Map<string, Promise<PDFDocumentProxy>>();
/** Drops a deleted notebook's PDF from this device: cached bytes, open document and rasters. */
export async function forgetPdf(id: string) {
  void documents.get(id)?.then(doc => doc.loadingTask.destroy()).catch(() => {}); documents.delete(id);
  for (const key of [...renders.keys()]) if (key.startsWith(`${id}:`)) renders.delete(key);
  await db.meta.delete(`pdf-bytes:${id}`);
}
/** Asks the server to remove stored PDFs no notebook can reach (deleted elsewhere, abandoned uploads). */
export function sweepStoredPdfs() {
  return fetch('/api/pdfs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sweep' }) }).then(() => {}, () => {});
}
export async function openPdf(id: string) {
  let task = documents.get(id);
  if (!task) {
    task = (async () => {
      let blob = await getMeta<Blob>(`pdf-bytes:${id}`);
      if (!blob) {
        const res = await fetch(`/api/pdfs?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const data = await res.json(); if (!res.ok) throw new Error(data.error || 'PDF unavailable');
        const download = await fetch(data.url); if (!download.ok) throw new Error('PDF download failed');
        blob = await download.blob();
        const bytes = await blob.arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b => b.toString(16).padStart(2,'0')).join('');
        if (blob.size !== data.size || !pdfSignature(new Uint8Array(bytes)) || hash !== data.sha256) throw new Error('PDF integrity check failed');
        await cachePdf(id, blob);
      }
      return (await pdfEngine()).getDocument({ data: new Uint8Array(await blob.arrayBuffer()), disableWorkerRendering: true }).promise;
    })();
    // Rendering is serialized; evict idle workers when moving between notebooks.
    if (documents.size >= 2) {
      const oldest = documents.keys().next().value!;
      const stale = documents.get(oldest)!; documents.delete(oldest);
      void stale.then(doc => doc.loadingTask.destroy()).catch(() => {});
    }
    documents.set(id, task);
    task.catch(() => documents.delete(id));
  }
  return task;
}
// iOS Safari refuses canvases above ~16.7 MP; stay under it even for tall pages.
const MAX_RASTER_PIXELS = 16_000_000;
/** Device pixels per CSS pixel for a page: the screen's density (≤ 2), in quarter steps so the cache stays small. */
export function rasterScale(page: Pick<PdfPage, 'height'>, density = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1) {
  const fit = Math.sqrt(MAX_RASTER_PIXELS / (PAGE_WIDTH * page.height));
  return Math.max(0.25, Math.floor(Math.min(density, 2, fit) * 4) / 4);
}
// A small LRU of compressed rasters, shared by the viewport and exports. No 149-page canvas set.
const renders = new Map<string, Blob>();
let renderQueue: Promise<unknown> = Promise.resolve();
export function pdfRaster(page: PdfPage, density?: number): Promise<Blob> {
  const scale = rasterScale(page, density);
  const key = `${page.documentId}:${page.page}:${scale}`;
  const cached = renders.get(key);
  if (cached) { renders.delete(key); renders.set(key,cached); return Promise.resolve(cached); }
  const job = renderQueue.catch(() => {}).then(async () => {
    const existing = renders.get(key); if (existing) return existing;
    const doc = await openPdf(page.documentId), p = await doc.getPage(page.page);
    const viewport = p.getViewport({ scale: scale * PAGE_WIDTH / p.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PDF render failed')), 'image/png'));
      renders.set(key,blob); while (renders.size > 6) renders.delete(renders.keys().next().value!);
      return blob;
    } finally { canvas.width = canvas.height = 0; p.cleanup(); }
  });
  renderQueue = job; return job;
}
export async function pdfImage(page: PdfPage, density?: number) {
  const url = URL.createObjectURL(await pdfRaster(page, density));
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
