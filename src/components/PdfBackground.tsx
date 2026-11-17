'use client';
import { useEffect, useRef, useState } from 'react';
import { pdfRaster } from '@/lib/pdf';
import type { PdfPage } from '@/lib/pdf-meta';
export function PdfBackground({ page }: { page: PdfPage }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let active = true, near = false, current = '';
    const observer = new IntersectionObserver(entries => {
      near = entries[0].isIntersecting;
      if (!near) { setUrl(''); URL.revokeObjectURL(current); current = ''; return; }
      pdfRaster(page).then(blob => {
        if (!active || !near) return;
        URL.revokeObjectURL(current); current = URL.createObjectURL(blob); setUrl(current); setError('');
      }, e => { if (active) setError(String(e.message)); });
    }, { rootMargin: '800px' });
    observer.observe(ref.current!);
    return () => { active = false; observer.disconnect(); URL.revokeObjectURL(current); };
  }, [page]);
  return <div ref={ref} className="pointer-events-none absolute left-0 top-0" style={{ width: 1376, height: page.height }} data-pdf-background>
    {/* PDF rasters are local blob URLs, generated only near the viewport. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url ? <img src={url} alt={`${page.name}, page ${page.page}`} width={1376} height={page.height} /> : <p role="status" className="p-6 text-slate-500">{error || `PDF page ${page.page} · loading when visible`}</p>}
  </div>;
}
