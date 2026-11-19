import { db, getMeta, setMeta } from './db';
import { PAGE_WIDTH } from './types';
import { pdfSignature, type PdfPage } from './pdf-meta';
import { registerDebugProbe } from './sync-debug';
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
  for (const key of [...thumbs.keys()]) if (key.startsWith(`${id}:`)) { void thumbs.get(key)!.then(url => url && URL.revokeObjectURL(url)); thumbs.delete(key); }
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
// An LRU of compressed rasters, shared by the viewport and exports, kept to a byte budget rather
// than a count: a zoom through a long PDF asks for every page in view at the new density, and
// going back to the old zoom should find them still here. No 149-page canvas set.
const renders = new Map<string, Blob>();
const RENDER_BUDGET = 48 * 1024 * 1024;
let renderQueue: Promise<unknown> = Promise.resolve();
registerDebugProbe('PDF cache', () => ({ openDocuments: documents.size, cachedRasters: renders.size, rasterMB: Math.round([...renders.values()].reduce((a, b) => a + b.size, 0) / 10485.76) / 100 }));
function remember(key: string, blob: Blob) {
  renders.set(key, blob);
  let total = 0;
  for (const b of renders.values()) total += b.size;
  for (const [k, b] of renders) { if (total <= RENDER_BUDGET || renders.size <= 1) break; renders.delete(k); total -= b.size; }
}
/** Any raster of the page already cached, sharpest first, to show while the wanted one renders. */
export function cachedPdfRaster(page: PdfPage): Blob | null {
  let best: Blob | null = null, bestScale = 0;
  for (const [key, blob] of renders) {
    const at = key.lastIndexOf(':');
    if (key.slice(0, at) !== `${page.documentId}:${page.page}`) continue;
    const scale = Number(key.slice(at + 1));
    if (scale > bestScale) { best = blob; bestScale = scale; }
  }
  return best;
}
/**
 * Renders are serialized, so a request whose `signal` aborts before its turn (the page scrolled
 * away, or the zoom moved on) is skipped rather than holding up the pages in view.
 */
export function pdfRaster(page: PdfPage, density?: number, signal?: AbortSignal): Promise<Blob> {
  const scale = rasterScale(page, density);
  const key = `${page.documentId}:${page.page}:${scale}`;
  const cached = renders.get(key);
  if (cached) { renders.delete(key); renders.set(key,cached); return Promise.resolve(cached); }
  const job = renderQueue.catch(() => {}).then(async () => {
    const existing = renders.get(key); if (existing) return existing;
    signal?.throwIfAborted();
    const doc = await openPdf(page.documentId), p = await doc.getPage(page.page);
    const viewport = p.getViewport({ scale: scale * PAGE_WIDTH / p.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PDF render failed')), 'image/png'));
      remember(key, blob);
      return blob;
    } finally { canvas.width = canvas.height = 0; p.cleanup(); }
  });
  renderQueue = job; return job;
}
export async function pdfImage(page: PdfPage, density?: number) {
  const url = URL.createObjectURL(await pdfRaster(page, density));
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
// Library thumbnails: page rasters at a low density, kept as object URLs for the session.
const thumbs = new Map<string, Promise<string | null>>();
/**
 * A small raster of a PDF page for a library card, or null when this device has no copy of the
 * file (a thumbnail never downloads a whole PDF) or it fails to render.
 */
export function pdfThumbnail(page: PdfPage): Promise<string | null> {
  const key = `${page.documentId}:${page.page}`;
  let job = thumbs.get(key);
  if (!job) {
    job = (async () => {
      if (!(await db.meta.where('key').equals(`pdf-bytes:${page.documentId}`).count())) return null;
      return URL.createObjectURL(await pdfRaster(page, 0.5));
    })().catch(() => null);
    // Misses are not remembered, so a PDF cached later (opening the notebook) gets its preview.
    void job.then((url) => { if (!url) thumbs.delete(key); });
    thumbs.set(key, job);
  }
  return job;
}
