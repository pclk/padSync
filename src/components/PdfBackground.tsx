'use client';
import { useEffect, useRef, useState } from 'react';
import { pdfRaster } from '@/lib/pdf';
import type { PdfPage } from '@/lib/pdf-meta';
/**
 * Device pixels per page pixel for the raster: zoomed out, a page shows at a fraction of its size,
 * and a full-density decode (~39 MB a page on an iPad) for each of the many pages in view runs
 * Safari out of memory. Three tiers, so a pinch re-renders a page at most when it crosses one.
 */
export function pdfDensity(zoom: number, dpr: number) {
  return dpr * (zoom <= 0.5 ? 0.5 : zoom <= 0.75 ? 0.75 : 1);
}
export function PdfBackground({ page, zoom }: { page: PdfPage; zoom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  const shown = useRef('');
  const density = pdfDensity(zoom, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  useEffect(() => {
    let active = true, near = false;
    // The raster on screen stays until its replacement is ready, so a density change never blanks.
    const show = (next: string) => { URL.revokeObjectURL(shown.current); shown.current = next; setUrl(next); };
    const observer = new IntersectionObserver(entries => {
      near = entries[0].isIntersecting;
      if (!near) { show(''); return; }
      pdfRaster(page, density).then(blob => {
        if (!active || !near) return;
        show(URL.createObjectURL(blob)); setError('');
      }, e => { if (active) setError(String(e.message)); });
    }, { rootMargin: '800px' });
    observer.observe(ref.current!);
    return () => { active = false; observer.disconnect(); };
  }, [page, density]);
  useEffect(() => () => URL.revokeObjectURL(shown.current), []);
  return <div ref={ref} className="pointer-events-none absolute left-0 top-0" style={{ width: 1376, height: page.height }} data-pdf-background>
    {/* PDF rasters are local blob URLs, generated only near the viewport. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url ? <img src={url} alt={`${page.name}, page ${page.page}`} width={1376} height={page.height} decoding="async" /> : <p role="status" className="p-6 text-slate-500">{error || `PDF page ${page.page} · loading when visible`}</p>}
  </div>;
}
