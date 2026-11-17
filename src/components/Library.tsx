"use client";
import PdfImport from "./PdfImport";
import { forgetPdf, sweepStoredPdfs } from "@/lib/pdf";

import { useEffect, useRef, useState } from "react";
import { selectNotebooks, type LibrarySort } from "@/lib/library";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, deviceId } from "@/lib/db";
import { createNotebook, listNotebooks, putEntities } from "@/lib/store";
import type { NotebookEntity, PresenceEntity, SectionData } from "@/lib/types";
import { SyncBadge } from "./SyncBadge";
import { Icon, Logo } from "./Icons";
import { Dialog } from "./Dialog";
import { deferredAction } from "@/lib/deferred";

/** How long the "Undo" toast stays after deleting a notebook; the delete is written after it. */
export const UNDO_MS = 6000;

export default function Library() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const mutate = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch { setError("Could not save your change on this device. Please try again."); }
    finally { pending.current = false; setBusy(false); }
  };
  const [renaming, setRenaming] = useState<NotebookEntity | null>(null);
  const [confirming, setConfirming] = useState<NotebookEntity | null>(null);
  const [deleted, setDeleted] = useState<NotebookEntity | null>(null);
  // The delete is only written once the undo window closes, so undo never reaches sync (the
  // server removes stored PDFs as soon as it sees a deleted notebook). Until then it is hidden.
  const commitDelete = async (nb: NotebookEntity) => {
    setDeleted((d) => (d?.id === nb.id ? null : d));
    try {
      const row = ((await db.entities.get(nb.id)) as NotebookEntity | undefined) ?? nb;
      await putEntities([{ ...row, deleted: 1 }]);
    } catch {
      setError(`Could not delete “${nb.data.title}” on this device. Please try again.`);
      return;
    }
    // The server removes stored PDFs of deleted notebooks; this device's copy goes now.
    const secs = await db.entities.where("[notebookId+kind]").equals([nb.id, "section"]).toArray();
    for (const id of new Set(secs.flatMap((s) => (s.data as SectionData).pdf?.documentId ?? []))) await forgetPdf(id).catch(() => {});
  };
  const [deletion] = useState(() => deferredAction(commitDelete, UNDO_MS));
  // Leaving the library or closing the tab ends the undo window early.
  useEffect(() => {
    const flush = () => void deletion.flush();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [deletion]);
  // Clears stored PDFs of notebooks deleted on any device, including before this fix shipped.
  useEffect(() => { void sweepStoredPdfs(); }, []);
  const notebooks = useLiveQuery(listNotebooks, []);
  const counts = useLiveQuery(async () => {
    const secs = await db.entities.where("kind").equals("section").filter((s) => !s.deleted).toArray();
    const m = new Map<string, number>();
    secs.forEach((s) => m.set(s.notebookId, (m.get(s.notebookId) ?? 0) + 1));
    return m;
  }, []);
  const ipad = useLiveQuery(async () => {
    const ps = (await db.entities.where("kind").equals("presence").toArray()) as PresenceEntity[];
    return ps.filter((p) => p.data.deviceKind === "ipad" && p.data.device !== deviceId()).sort((a, b) => b.data.at - a.data.at)[0];
  }, []);

  const live = deleted ? notebooks?.filter((n) => n.id !== deleted.id) : notebooks;
  const sorted = selectNotebooks(live ?? [], query, sort);
  const ipadNb = ipad && live?.find((n) => n.id === ipad.notebookId);

  const newBlank = () => mutate(async () => {
    const id = await createNotebook("Untitled notebook");
    router.push(`/notebook?id=${id}`);
  });

  const rename = async (nb: NotebookEntity, title: string) => {
    setRenaming(null);
    if (title && title !== nb.data.title) await mutate(async () => { await putEntities([{ ...nb, data: { ...nb.data, title } }]); });
  };

  const remove = (nb: NotebookEntity) => {
    setConfirming(null);
    setError("");
    setDeleted(nb);
    void deletion.schedule(nb);
  };

  const undoDelete = () => {
    deletion.undo();
    setDeleted(null);
  };

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-5 sm:px-8 sm:pt-8">
      <header className="mb-10 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <Logo />
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">padSync</h1>
        </div>
        <SyncBadge />
        <nav aria-label="Library" className="ml-auto flex flex-wrap items-center gap-1.5">
          <Link href="/import" className="btn btn-ghost"><Icon name="sparkles" className="text-brand-600" />AI import</Link>
          <Link href="/settings" className="icon-btn" aria-label="Settings" title="Settings"><Icon name="settings" className="text-lg" /></Link>
          <button disabled={busy} onClick={newBlank} className="btn btn-primary"><Icon name="plus" />{busy ? "Saving…" : "New notebook"}</button>
        </nav>
      </header>

      <section className="mb-6 flex flex-wrap items-end justify-between gap-4" aria-labelledby="library-title">
        <div>
          <h2 id="library-title" className="text-3xl font-semibold tracking-tight text-slate-900">Your notebooks</h2>
          <p className="mt-1 text-sm text-slate-500">A place to write, practise, and bring your notes together.</p>
        </div>
        {!!live?.length && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <span className="sr-only">Search notebooks</span>
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input ref={searchInput} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title…" className="field pl-9" />
            </label>
            <label>
              <span className="sr-only">Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} className="field w-auto pr-8">
                <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option>
              </select>
            </label>
          </div>
        )}
      </section>

      {error && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}
      {ipadNb && (
        <Link href={`/notebook?id=${ipadNb.id}`} className="mb-6 flex items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 transition-colors hover:bg-brand-100">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-on-accent"><Icon name="tablet" /></span>
          <span className="min-w-0 break-words">Currently on <strong>{ipadNb.data.title}</strong>. Open and follow →</span>
        </Link>
      )}

      <PdfImport />

      {!!live?.length && <p role="status" className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-slate-400">{sorted.length} of {live.length} notebooks</p>}
      {live === undefined ? <p role="status" className="py-12 text-center text-slate-500">Loading notebooks…</p> : live.length > 0 && sorted.length === 0 ? (
        <div className="card p-10 text-center">
          <h3 className="font-medium text-slate-900">No matching notebooks</h3>
          <p className="mt-2 text-sm text-slate-500">Try another title or clear your search to see all your notebooks.</p>
          <button onClick={() => { setQuery(""); searchInput.current?.focus(); }} className="btn btn-secondary mt-4">Clear search</button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-card">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-2xl text-brand-600"><Icon name="notebook" /></span>
          <p className="mb-2 text-lg font-semibold text-slate-900">Start your first notebook</p>
          <p className="mx-auto max-w-md text-sm text-slate-500">
            Import a PDF above, drop your lecture notes into <Link href="/import" className="font-medium text-brand-700 hover:underline">AI import</Link> to get notes and practice to write on, or start a blank notebook.
          </p>
          <button disabled={busy} onClick={newBlank} className="btn btn-primary mt-6"><Icon name="plus" />New notebook</button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((nb) => (
            <li key={nb.id} className="group card relative overflow-hidden transition-shadow hover:shadow-lift">
              <Link href={`/notebook?id=${nb.id}`} className="block rounded-2xl">
                <div className="relative m-3 mb-0 aspect-[16/10] overflow-hidden rounded-xl border border-slate-100 bg-[#fdfdfb]">
                  <div className="absolute inset-0 bg-[radial-gradient(#d5dbe5_1px,transparent_1px)] [background-size:14px_14px] transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none" />
                </div>
                <div className="py-3 pl-4 pr-20">
                  <div className="truncate font-medium text-slate-900" title={nb.data.title}>{nb.data.title}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {counts === undefined ? "…" : (counts.get(nb.id) ?? 0)} {(counts?.get(nb.id) ?? 0) === 1 ? "section" : "sections"} · {new Date(nb.data.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </Link>
              <div className="absolute bottom-2.5 right-2 flex gap-0.5">
                <button disabled={busy} aria-label={`Rename ${nb.data.title}`} title="Rename" onClick={() => setRenaming(nb)} className="icon-btn h-8 w-8"><Icon name="edit" /></button>
                <button disabled={busy} aria-label={`Delete ${nb.data.title}`} title="Delete" onClick={() => setConfirming(nb)} className="icon-btn h-8 w-8 hover:!bg-rose-50 hover:!text-rose-600"><Icon name="trash" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {renaming && <RenameDialog notebook={renaming} onCancel={() => setRenaming(null)} onRename={(title) => rename(renaming, title)} />}
      {confirming && <DeleteDialog notebook={confirming} onCancel={() => setConfirming(null)} onDelete={() => remove(confirming)} />}
      {deleted && <UndoToast key={deleted.id} title={deleted.data.title} onUndo={undoDelete} />}
    </main>
  );
}

export function RenameDialog({ notebook, onCancel, onRename }: { notebook: NotebookEntity; onCancel: () => void; onRename: (title: string) => void }) {
  const [title, setTitle] = useState(notebook.data.title);
  return (
    <Dialog title="Rename notebook" onClose={onCancel} onSubmit={() => { if (title.trim()) onRename(title.trim()); }}>
      <label className="mt-4 block">
        <span className="sr-only">Notebook title</span>
        <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} className="field" />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={!title.trim()} className="btn btn-primary">Rename</button>
      </div>
    </Dialog>
  );
}

export function DeleteDialog({ notebook, onCancel, onDelete }: { notebook: NotebookEntity; onCancel: () => void; onDelete: () => void }) {
  return (
    <Dialog title={`Delete “${notebook.data.title}”?`} onClose={onCancel} onSubmit={onDelete}>
      <p className="mt-2 break-words text-sm text-slate-500">The notebook and its pages are removed from all your devices. You can undo this for a few seconds.</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" data-autofocus className="btn btn-secondary !border-rose-200 !text-rose-700 hover:!bg-rose-50"><Icon name="trash" />Delete</button>
      </div>
    </Dialog>
  );
}

export function UndoToast({ title, onUndo }: { title: string; onUndo: () => void }) {
  return (
    <div role="status" className="card fixed bottom-6 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 py-2 pl-4 pr-2 text-sm text-slate-700 shadow-lift">
      <span className="min-w-0 flex-1 truncate">Deleted “{title}”</span>
      <button type="button" onClick={onUndo} className="btn btn-sm btn-ghost font-semibold !text-brand-700">Undo</button>
    </div>
  );
}
