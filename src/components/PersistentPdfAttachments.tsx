'use client';
import { useEffect, useRef, useState } from 'react';
import { deletePersistentPdf, getPersistentPdfBlob, listPersistentPdfs, uploadPersistentPdf, type PersistentPdf, type ResolvedPdf } from '@/lib/persistent-attachments';
import { parseSelectedPages } from '@/lib/persistent-attachment-meta';
import { formatBytes } from '@/lib/attachments';

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
  return <section aria-label="Saved lecture PDFs" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); add(Array.from(e.dataTransfer.files)); }}>
    <p>Lecture PDFs are saved to this notebook and available on your other devices. Drop PDFs here or choose files.</p>
    <input aria-label="Upload lecture PDFs" type="file" accept=".pdf,application/pdf" multiple disabled={offline || !!busy} onChange={e => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    <button type="button" disabled={offline || !!busy} onClick={() => void run(async () => { setBusy('Refreshing saved PDFs…'); setFiles(await listPersistentPdfs(notebookId)); })}>Refresh saved PDFs</button>
    {offline && <p role="status">Offline — reconnect to upload or open saved PDFs.</p>}
    {busy && <p role="status">{busy}</p>}
    {error && <p role="alert">{error} Retry by choosing the file or opening it again.</p>}
    {!busy && !files.length && <p>No saved PDFs available.</p>}
    <ul>{files.map(file => <li key={file.id}>
      <label><input type="checkbox" checked={selected.some(f => f.meta.id === file.id)} disabled={offline || !!busy} onChange={e => { if (!e.target.checked) setSelected(old => old.filter(f => f.meta.id !== file.id)); else void run(() => resolve(file, false)); }} />{file.name} ({formatBytes(file.size)})</label>
      <label>Source pages <input placeholder="All pages, or 1, 3-5" value={pages[file.id] ?? ''} disabled={!!busy} onChange={e => {
        const value = e.target.value; setPages(old => ({ ...old, [file.id]: value }));
        // Invalid edits immediately deselect: no stale page provenance can be sent.
        setSelected(old => old.filter(f => f.meta.id !== file.id));
        try { parseSelectedPages(value); setError(''); } catch (err) { setError((err as Error).message); }
      }} /></label>
      <button type="button" disabled={offline || !!busy} onClick={() => void run(() => resolve(file, true))}>View PDF</button>
      <button type="button" disabled={offline || !!busy} onClick={() => void run(async () => { setBusy('Removing PDF…'); await deletePersistentPdf(file.id); setFiles(old => old.filter(f => f.id !== file.id)); setSelected(old => old.filter(f => f.meta.id !== file.id)); })}>Remove saved PDF</button>
    </li>)}</ul>
    {view && <div><button type="button" onClick={() => setView(undefined)}>Close PDF</button><p><a href={view.url} target="_blank" rel="noreferrer">Open {view.name}</a></p><iframe title={view.name} src={view.url} style={{ width: '100%', height: 600 }} /></div>}
  </section>;
}
