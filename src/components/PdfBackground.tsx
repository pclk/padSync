'use client';
import { useEffect, useRef, useState } from 'react';
import { cachedPdfRaster, pdfRaster } from '@/lib/pdf';
import type { PdfPage } from '@/lib/pdf-meta';
import { renderFlag } from '@/lib/render-flags';
/**
 * Device pixels per page pixel for the raster: what the zoom shows on screen, rounded up to a
 * quarter step (rasterScale's steps), between half and full screen density. Zoomed out, a
 * full-density decode (~30-39 MB a page on an iPad) for each of the pages in view runs Safari out
 * of memory; at 80% a page needs 1.75x, not 2x.
 */
export function pdfDensity(zoom: number, dpr: number, quarterSteps = renderFlag('quarterSteps')) {
  if (!quarterSteps) return dpr * (zoom <= 0.5 ? 0.5 : zoom <= 0.75 ? 0.75 : 1);
  return Math.min(dpr, Math.max(dpr / 2, Math.ceil(dpr * zoom * 4) / 4));
}
// A zoom or window resize changes the density many times in a row; each change would re-render
// every page in view through pdf.js and PNG, seconds of work on a long PDF. The raster on screen
// (stretched by CSS) stays until the zoom has been still this long.
const SETTLE_MS = 250;
export function PdfBackground({ page, zoom }: { page: PdfPage; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const [near, setNear] = useState(false);
  const shown = useRef('');
  const density = pdfDensity(zoom, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const [settled, setSettled] = useState(density);
  useEffect(() => {
    if (density === settled) return;
    const timer = setTimeout(() => setSettled(density), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [density, settled]);
  // One observer for the page's lifetime, not one per zoom.
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { rootMargin: '800px' });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const show = (next: string) => { URL.revokeObjectURL(shown.current); shown.current = next; setUrl(next); };
    if (!near) { show(''); return; }
    const abort = new AbortController();
    // Decoded before it goes on screen: Safari otherwise paints the page blank for a frame or
    // more while it decodes, a flash on every zoom. The raster on screen stays until then.
    let sharp = false;
    const swapIn = async (blob: Blob, final: boolean) => {
      sharp ||= final;
      const next = URL.createObjectURL(blob);
      const img = new Image();
      img.src = next;
      await img.decode().catch(() => {});
      if (abort.signal.aborted || (sharp && !final)) return URL.revokeObjectURL(next);
      show(next); setError('');
    };
    // A page coming into view shows any cached raster of it at once, then sharpens.
    const stand = shown.current ? null : cachedPdfRaster(page);
    if (stand) void swapIn(stand, false);
    pdfRaster(page, settled, abort.signal).then(blob => blob === stand ? undefined : swapIn(blob, true), e => {
      if (!abort.signal.aborted) setError(String(e.message));
    });
    return () => abort.abort();
  }, [page, settled, near]);
  useEffect(() => () => URL.revokeObjectURL(shown.current), []);
  return <div ref={ref} className="pointer-events-none absolute left-0 top-0" style={{ width: 1376, height: page.height }} data-pdf-background>
    {/* PDF rasters are local blob URLs, generated only near the viewport. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url ? <img src={url} alt={`${page.name}, page ${page.page}`} width={1376} height={page.height} decoding="sync" /> : <p role="status" className="p-6 text-slate-500">{error || `PDF page ${page.page} · loading when visible`}</p>}
  </div>;
}
