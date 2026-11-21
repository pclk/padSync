'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import { cachePdf, pdfEngine } from '@/lib/pdf';
import { MAX_PDF_BYTES, PDF_PART_BYTES, pdfSections, pdfSignature } from '@/lib/pdf-meta';
import { createNotebook } from '@/lib/store';
import { Icon } from './Icons';
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
export default function PdfImport({ folderId }: { folderId?: string }) {
  const router = useRouter(), cancel = useRef<AbortController | null>(null);
  const [busy,setBusy] = useState(false), [status,setStatus] = useState(''), [problems,setProblems] = useState<string[]>([]), [progress,setProgress] = useState(0), [local,setLocal] = useState(false), [offline,setOffline] = useState(false), [over,setOver] = useState(false);
  useEffect(() => { const update = () => setOffline(!navigator.onLine); update(); window.addEventListener('online',update); window.addEventListener('offline',update); return () => { window.removeEventListener('online',update); window.removeEventListener('offline',update); cancel.current?.abort(); }; },[]);
  /** Imports one PDF as a notebook and returns its id. `say` prefixes progress with the file's place in the queue. */
  async function importOne(file: File, signal: AbortSignal, say: (s: string) => void) {
    let remoteId = '', committed = false;
    try {
      if (file.size > MAX_PDF_BYTES || !pdfSignature(new Uint8Array(await file.slice(0,5).arrayBuffer()))) throw new Error('Choose a PDF up to 100 MiB.');
      if (!local && !navigator.onLine) throw new Error('Offline. Choose Local only or reconnect.');
      say('Reading PDF pages…');
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
          pages.push({ width: v.width, height: v.height, text: text.items.map(x => 'str' in x ? x.str + (x.hasEOL ? '\n' : ' ') : '').join('').replace(/\0/g,'').toWellFormed() }); p.cleanup();
          say(`Reading page ${i} of ${doc.numPages}…`);
        }
      } finally { signal.removeEventListener('abort',abortRead); await loading.destroy(); }
      const notebookId = nanoid(); let documentId = `local-${nanoid()}`;
      // Validate geometry before uploading any bytes.
      pdfSections(documentId,file.name,pages);
      if (!local) {
        say('Uploading PDF…');
        // Let creation finish even after cancel so its upload id is available for cleanup.
        const upload = await api({ action: 'create', notebookId, name: file.name, size: file.size, pageCount: pages.length, sha256 });
        remoteId = documentId = upload.id;
        for (let i=0;i<upload.urls.length;i++) { signal.throwIfAborted(); await put(upload.urls[i],file.slice(i*PDF_PART_BYTES,(i+1)*PDF_PART_BYTES),signal,n => setProgress(Math.round(100*(i*PDF_PART_BYTES+n)/file.size))); }
        signal.throwIfAborted(); await api({ action: 'complete', id: documentId },signal);
      }
      signal.throwIfAborted(); say('Saving notebook…');
      await cachePdf(documentId,file);
      await createNotebook(file.name.replace(/\.pdf$/i,''),pdfSections(documentId,file.name,pages),local ? 'PDF stored on this device only.' : undefined,undefined,notebookId,folderId || undefined);
      committed = true; return notebookId;
    } finally { if (remoteId && !committed) await api({ action: 'abort', id: remoteId }).catch(() => {}); }
  }
  async function run(list?: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (!files.length || cancel.current) return;
    const controller = new AbortController(); cancel.current = controller; const signal = controller.signal;
    setBusy(true); setProblems([]);
    const made: string[] = [], errors: { name: string; error: string }[] = [];
    try {
      for (const [n,file] of files.entries()) {
        if (signal.aborted) break;
        setProgress(0);
        const say = files.length === 1 ? setStatus : (s: string) => setStatus(`${file.name} (${n+1} of ${files.length}): ${s}`);
        try { made.push(await importOne(file,signal,say)); }
        catch(e) { if (signal.aborted) break; errors.push({ name: file.name, error: e instanceof Error ? e.message : 'PDF import failed.' }); }
      }
    } finally { cancel.current = null; setBusy(false); }
    // One PDF opens straight away; a batch stays in the library so all the new notebooks are in view.
    if (files.length === 1 && made.length === 1) { setStatus('Saving notebook…'); router.push(`/notebook?id=${made[0]}`); return; }
    const done = made.length ? `Imported ${made.length} ${made.length === 1 ? 'notebook' : 'notebooks'}.` : '';
    if (signal.aborted) setStatus(`Import cancelled.${done ? ` ${done}` : ''}`);
    else if (files.length === 1) setStatus(errors[0]?.error ?? 'PDF import failed.');
    else { setStatus(errors.length ? `${done} ${errors.length} could not be imported:`.trim() : done); setProblems(errors.map(f => `${f.name}: ${f.error}`)); }
  }
  const failed = !busy && !!status && status !== 'Saving notebook…' && !status.startsWith('Imported');
  return <div id="pdf-import" data-over={over} className="dropzone flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:p-5"
    onDragOver={e => { e.preventDefault(); if (!busy) setOver(true); }} onDragLeave={() => setOver(false)}
    onDrop={e => { e.preventDefault(); setOver(false); if (!busy) void run(e.dataTransfer.files); }}>
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-xl text-rose-600"><Icon name="file" /></span>
    <div className="min-w-0 flex-1 basis-56">
      <p className="font-medium text-slate-900">Import PDFs</p>
      <p className="text-sm text-slate-500">Drop one or more PDFs here; each becomes a notebook, one page per section. Up to 100 MiB each.</p>
    </div>
    <label className="ml-auto flex items-center gap-2 text-sm text-slate-600" title="The PDF stays on this device and is not uploaded">
      <input type="checkbox" checked={local} disabled={busy} onChange={e => setLocal(e.target.checked)} /> Local only
    </label>
    <label className={`btn btn-secondary ${busy ? 'pointer-events-none opacity-50' : ''}`}>
      <Icon name="upload" />Choose PDFs
      <input aria-label="Import PDFs" type="file" accept="application/pdf,.pdf" multiple disabled={busy} className="sr-only" onChange={e => { void run(e.target.files && Array.from(e.target.files)); e.target.value = ''; }} />
    </label>
    {(busy || status || offline) && <div className="w-full space-y-2 border-t border-slate-100 pt-3">
      {offline && <p className="text-sm text-amber-700">Offline — local import is available.</p>}
      {busy && <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${progress}%` }} /></div>
        <progress aria-label="PDF upload progress" value={progress} max={100} className="sr-only" />
        <span className="w-10 text-right text-xs tabular-nums text-slate-500">{progress}%</span>
        <button className="btn btn-ghost btn-sm" onClick={() => cancel.current?.abort()}>Cancel</button>
      </div>}
      <p role="status" className={`break-words text-sm ${failed ? 'text-rose-700' : 'text-slate-600'}`}>{status}</p>
      {!busy && !!problems.length && <ul className="list-disc space-y-0.5 break-words pl-5 text-sm text-rose-700">{problems.map((p,i) => <li key={i}>{p}</li>)}</ul>}
    </div>}
  </div>;
}
