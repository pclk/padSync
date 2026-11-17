'use client';
import { useEffect, useRef, useState } from 'react';
import { deletePersistentPdf, getPersistentPdfBlob, listPersistentPdfs, uploadPersistentPdf, type PersistentPdf, type ResolvedPdf } from '@/lib/persistent-attachments';
import { parseSelectedPages } from '@/lib/persistent-attachment-meta';
import { formatBytes } from '@/lib/attachments';
import { Icon } from './Icons';

/** Manual PDFs only. The host combines resolved selections with its existing draft attachments. */
type Props = { notebookId: string; onChange: (files: ResolvedPdf[]) => void };
export default function PersistentPdfAttachments(props: Props) {
  return <PdfAttachments key={props.notebookId} {...props} />;
}
function PdfAttachments({ notebookId, onChange }: Props) {
  const [files, setFiles] = useState<PersistentPdf[]>([]);
  const [selected, setSelected] = useState<ResolvedPdf[]>([]);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState('Loading saved PDFs…');
  const [error, setError] = useState('');
  const [pages, setPages] = useState<Record<string, string>>({});
  const [view, setView] = useState<{ url: string; name: string }>();
  const generation = useRef(0);
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; }, [onChange]);
  useEffect(() => { callback.current(selected); }, [selected]);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    listPersistentPdfs(notebookId, controller.signal).then(list => { if (generation.current === current) setFiles(list); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (generation.current === current) setBusy(''); });
    return () => { generation.current = current + 1; controller.abort(); };
  }, [notebookId]);
  useEffect(() => () => { if (view) URL.revokeObjectURL(view.url); }, [view]);
  async function run(action: () => Promise<void>) {
    setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'PDF unavailable. Try again.'); } finally { setBusy(''); }
  }
  function add(input: File[]) {
    if (busy || offline) return;
    const current = generation.current;
    void run(async () => {
      for (const file of input) {
        setBusy(`Uploading ${file.name}…`);
        const meta = await uploadPersistentPdf(notebookId, file, sent => { if (generation.current === current) setBusy(`Uploading ${file.name}: ${formatBytes(sent)} / ${formatBytes(file.size)}`); });
        if (generation.current !== current) return;
        setFiles(old => [...old, meta]);
      }
    });
  }
  async function resolve(file: PersistentPdf, preview: boolean) {
    const current = generation.current;
    setBusy(`Opening ${file.name}…`);
    const blob = await getPersistentPdfBlob(file);
    if (generation.current !== current) return;
    if (preview) setView({ url: URL.createObjectURL(blob), name: file.name });
    else setSelected(old => [...old.filter(f => f.meta.id !== file.id), { meta: { ...file, selectedPages: parseSelectedPages(pages[file.id] ?? '') }, blob }]);
  }
  const locked = offline || !!busy;
  return <section aria-label="Saved lecture PDFs" className="space-y-3" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); add(Array.from(e.dataTransfer.files)); }}>
    <p className="text-slate-500">Lecture PDFs are saved to this notebook and available on your other devices. Drop PDFs here or choose files.</p>
    <div className="flex flex-wrap gap-2">
      <label className={`btn btn-secondary ${locked ? 'pointer-events-none opacity-50' : ''}`}><Icon name="upload" />Upload PDFs
        <input aria-label="Upload lecture PDFs" type="file" accept=".pdf,application/pdf" multiple disabled={locked} className="sr-only" onChange={e => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      </label>
      <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void run(async () => { setBusy('Refreshing saved PDFs…'); setFiles(await listPersistentPdfs(notebookId)); })}>Refresh saved PDFs</button>
    </div>
    {offline && <p role="status" className="text-amber-700">Offline — reconnect to upload or open saved PDFs.</p>}
    {busy && <p role="status" className="text-slate-600">{busy}</p>}
    {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">{error} Retry by choosing the file or opening it again.</p>}
    {!busy && !files.length && <p className="text-slate-400">No saved PDFs available.</p>}
    {!!files.length && <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">{files.map(file => <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={selected.some(f => f.meta.id === file.id)} disabled={locked} onChange={e => { if (!e.target.checked) setSelected(old => old.filter(f => f.meta.id !== file.id)); else void run(() => resolve(file, false)); }} /><span className="truncate font-medium text-slate-800">{file.name}</span> <span className="shrink-0 text-xs text-slate-400">{formatBytes(file.size)}</span></label>
      <label className="flex items-center gap-2 text-xs text-slate-500">Source pages <input className="field w-36 py-1 text-xs" placeholder="All pages, or 1, 3-5" value={pages[file.id] ?? ''} disabled={!!busy} onChange={e => {
        const value = e.target.value; setPages(old => ({ ...old, [file.id]: value }));
        // Invalid edits immediately deselect: no stale page provenance can be sent.
        setSelected(old => old.filter(f => f.meta.id !== file.id));
        try { parseSelectedPages(value); setError(''); } catch (err) { setError((err as Error).message); }
      }} /></label>
      <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={() => void run(() => resolve(file, true))}>View PDF</button>
      <button type="button" className="icon-btn h-8 w-8 hover:!bg-rose-50 hover:!text-rose-600" aria-label="Remove saved PDF" title="Remove saved PDF" disabled={locked} onClick={() => void run(async () => { setBusy('Removing PDF…'); await deletePersistentPdf(file.id); setFiles(old => old.filter(f => f.id !== file.id)); setSelected(old => old.filter(f => f.meta.id !== file.id)); })}><Icon name="trash" /></button>
    </li>)}</ul>}
    {view && <div className="overflow-hidden rounded-xl border border-slate-200"><div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2"><a className="truncate font-medium text-brand-700 hover:underline" href={view.url} target="_blank" rel="noreferrer">Open {view.name}</a><button type="button" className="btn btn-ghost btn-sm" onClick={() => setView(undefined)}>Close PDF</button></div><iframe title={view.name} src={view.url} style={{ width: '100%', height: 600 }} /></div>}
  </section>;
}
