'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import { cachePdf, pdfEngine } from '@/lib/pdf';
import { MAX_PDF_BYTES, PDF_PART_BYTES, pdfSections, pdfSignature } from '@/lib/pdf-meta';
import { createNotebook } from '@/lib/store';
async function api(body: unknown, signal?: AbortSignal) {
  const r = await fetch('/api/pdfs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const d = await r.json(); if (!r.ok) throw new Error(d.error || 'PDF upload failed'); return d;
}
function put(url: string, blob: Blob, signal: AbortSignal, progress: (n: number) => void) {
  return new Promise<void>((resolve,reject) => {
    const xhr = new XMLHttpRequest(); const abort = () => xhr.abort();
    xhr.open('PUT',url); xhr.upload.onprogress = e => progress(e.loaded);
    xhr.onload = () => { signal.removeEventListener('abort',abort); if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error('Upload failed. Check bucket CORS and connection.')); };
    xhr.onerror = () => { signal.removeEventListener('abort',abort); reject(new Error('Upload failed. Check bucket CORS and connection.')); };
    xhr.onabort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort',abort,{ once: true }); if (signal.aborted) { reject(new Error('Cancelled')); return; } xhr.send(blob);
  });
}
export default function PdfImport() {
  const router = useRouter(), cancel = useRef<AbortController | null>(null);
  const [busy,setBusy] = useState(false), [status,setStatus] = useState(''), [progress,setProgress] = useState(0), [local,setLocal] = useState(false), [offline,setOffline] = useState(false);
  useEffect(() => { const update = () => setOffline(!navigator.onLine); update(); window.addEventListener('online',update); window.addEventListener('offline',update); return () => { window.removeEventListener('online',update); window.removeEventListener('offline',update); cancel.current?.abort(); }; },[]);
  async function run(file?: File) {
    if (!file || cancel.current) return;
    const controller = new AbortController(); cancel.current = controller; const signal = controller.signal;
    setBusy(true); setProgress(0); let remoteId = '', committed = false;
    try {
      if (file.size > MAX_PDF_BYTES || !pdfSignature(new Uint8Array(await file.slice(0,5).arrayBuffer()))) throw new Error('Choose a PDF up to 100 MiB.');
      if (!local && !navigator.onLine) throw new Error('Offline. Choose Local only or reconnect.');
      setStatus('Reading PDF pages…');
      const bytes = await file.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b => b.toString(16).padStart(2,'0')).join('');
      const engine = await pdfEngine(); signal.throwIfAborted();
      const loading = engine.getDocument({ data: new Uint8Array(bytes), disableWorkerRendering: true });
      const abortRead = () => { void loading.destroy(); }; signal.addEventListener('abort',abortRead,{ once: true });
      const pages = [];
      try {
        const doc = await loading.promise;
        if (doc.numPages > 2000) throw new Error('Maximum 2000 pages.');
        for (let i=1;i<=doc.numPages;i++) {
          signal.throwIfAborted(); const p = await doc.getPage(i), v = p.getViewport({ scale: 1 }), text = await p.getTextContent();
          pages.push({ width: v.width, height: v.height, text: text.items.map(x => 'str' in x ? x.str + (x.hasEOL ? '\n' : ' ') : '').join('') }); p.cleanup();
          setStatus(`Reading page ${i} of ${doc.numPages}…`);
        }
      } finally { signal.removeEventListener('abort',abortRead); await loading.destroy(); }
      const notebookId = nanoid(); let documentId = `local-${nanoid()}`;
      // Validate geometry before uploading any bytes.
      pdfSections(documentId,file.name,pages);
      if (!local) {
        setStatus('Uploading PDF…');
        // Let creation finish even after cancel so its upload id is available for cleanup.
        const upload = await api({ action: 'create', notebookId, name: file.name, size: file.size, pageCount: pages.length, sha256 });
        remoteId = documentId = upload.id;
        for (let i=0;i<upload.urls.length;i++) { signal.throwIfAborted(); await put(upload.urls[i],file.slice(i*PDF_PART_BYTES,(i+1)*PDF_PART_BYTES),signal,n => setProgress(Math.round(100*(i*PDF_PART_BYTES+n)/file.size))); }
        signal.throwIfAborted(); await api({ action: 'complete', id: documentId },signal);
      }
      signal.throwIfAborted(); setStatus('Saving notebook…');
      await cachePdf(documentId,file);
      await createNotebook(file.name.replace(/\.pdf$/i,''),pdfSections(documentId,file.name,pages),local ? 'PDF stored on this device only.' : undefined,undefined,notebookId);
      committed = true; router.push(`/notebook?id=${notebookId}`);
    } catch(e) { setStatus(signal.aborted ? 'Import cancelled.' : e instanceof Error ? e.message : 'PDF import failed.'); }
    finally { if (remoteId && !committed) await api({ action: 'abort', id: remoteId }).catch(() => {}); cancel.current = null; setBusy(false); }
  }
  return <div id="pdf-import" className="my-4 rounded-xl border p-4" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) void run(e.dataTransfer.files[0]); }}>
    <label className="font-medium">Import PDF <input aria-label="Import PDF" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => { void run(e.target.files?.[0]); e.target.value = ''; }} /></label>
    <p className="mt-2 text-sm text-slate-500">Drop a PDF to create a notebook, one page per section. Up to 100 MiB.</p>
    <label className="text-sm"><input type="checkbox" checked={local} disabled={busy} onChange={e => setLocal(e.target.checked)} /> Local only (PDF stays on this device)</label>
    {offline && <p className="text-amber-700">Offline — local import is available.</p>}
    {busy && <><progress aria-label="PDF upload progress" value={progress} max={100} /><button className="ml-3 underline" onClick={() => cancel.current?.abort()}>Cancel</button></>}
    <p role="status" className="text-sm">{status}</p>
  </div>;
}
