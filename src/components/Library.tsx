"use client";
import PdfImport from "./PdfImport";
import { forgetPdf, sweepStoredPdfs } from "@/lib/pdf";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { folderOf, folderPath, formatEdited, isWithin, selectNotebooks, sortFolders, type LibrarySort } from "@/lib/library";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, deviceId } from "@/lib/db";
import { createFolder, createNotebook, deleteFolder, lastEditedTimes, listFolders, listNotebooks, moveToFolder, putEntities } from "@/lib/store";
import type { FolderEntity, NotebookEntity, PresenceEntity, SectionData } from "@/lib/types";
import { SyncBadge } from "./SyncBadge";
import { Icon, Logo } from "./Icons";
import { Dialog } from "./Dialog";
import { NotebookThumb } from "./NotebookThumb";
import { deferredAction } from "@/lib/deferred";

/** How long the "Undo" toast stays after deleting a notebook; the delete is written after it. */
export const UNDO_MS = 6000;

/** The open folder is kept for the tab, so coming back from a notebook lands in the same folder. */
const FOLDER_KEY = "padsync.library.folder";
const DRAG_TYPE = "application/x-padsync-item";
type Item = NotebookEntity | FolderEntity;
const itemName = (i: Item) => (i.kind === "folder" ? i.data.name : i.data.title);

export default function Library() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
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
  const [folder, setFolderState] = useState(() => { try { return sessionStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; } });
  const setFolder = (id: string) => {
    setFolderState(id);
    setQuery("");
    try { sessionStorage.setItem(FOLDER_KEY, id); } catch {}
  };
  const [naming, setNaming] = useState<{ folder?: FolderEntity } | null>(null);
  const [moving, setMoving] = useState<Item | null>(null);
  const [removingFolder, setRemovingFolder] = useState<FolderEntity | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
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
  const edited = useLiveQuery(() => lastEditedTimes(), []);
  const folders = useLiveQuery(listFolders, []);
  // "Edited 5 min ago" has to keep counting while the library sits open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = deleted ? notebooks?.filter((n) => n.id !== deleted.id) : notebooks;
  const byId = new Map((folders ?? []).map((f) => [f.id, f]));
  // A folder deleted on another device drops back to the top level.
  const current = byId.has(folder) ? folder : "";
  const path = folderPath(current, byId);
  const searching = !!query.trim();
  // A search looks through every folder; otherwise the library shows the open folder.
  const scope = searching ? live ?? [] : (live ?? []).filter((n) => folderOf(n, byId) === current);
  const sorted = selectNotebooks(scope, query, sort, edited);
  const shownFolders = sortFolders((folders ?? []).filter((f) => (searching ? f.data.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : folderOf(f, byId) === current)));
  const inside = (id: string) => (live ?? []).filter((n) => folderOf(n, byId) === id).length + (folders ?? []).filter((f) => folderOf(f, byId) === id).length;
  const where = (item: Item) => folderPath(folderOf(item, byId), byId).map((f) => f.data.name).join(" › ");
  const ipadNb = ipad && live?.find((n) => n.id === ipad.notebookId);

  const newBlank = () => mutate(async () => {
    const id = await createNotebook("Untitled notebook", [], undefined, undefined, undefined, current || undefined);
    router.push(`/notebook?id=${id}`);
  });

  const saveFolder = (name: string) => {
    const target = naming?.folder;
    setNaming(null);
    if (target) { if (name !== target.data.name) void mutate(async () => { await putEntities([{ ...target, data: { ...target.data, name } }]); }); }
    else void mutate(async () => { await createFolder(name, current || undefined); });
  };

  const move = (item: Item, to: string) => {
    setMoving(null);
    if (folderOf(item, byId) === to || (item.kind === "folder" && isWithin(to, item.id, byId))) return;
    void mutate(() => moveToFolder([item], to));
  };

  const removeFolder = (f: FolderEntity) => {
    setRemovingFolder(null);
    if (current && isWithin(current, f.id, byId)) setFolder(f.data.folderId ?? "");
    void mutate(() => deleteFolder(f));
  };

  // Desktop drag and drop: drag a card onto a folder, or onto a crumb above, to move it there.
  const dragProps = (item: Item) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer.setData(DRAG_TYPE, item.id); e.dataTransfer.effectAllowed = "move"; },
  });
  const dropProps = (to: string) => ({
    onDragOver: (e: DragEvent) => { if (!e.dataTransfer.types.includes(DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(to); },
    onDragLeave: () => setDropTarget((t) => (t === to ? null : t)),
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!id) return;
      e.preventDefault();
      const item = live?.find((n) => n.id === id) ?? byId.get(id);
      if (item) move(item, to);
    },
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
        <SyncBadge align="start" />
        <nav aria-label="Library" className="ml-auto flex flex-wrap items-center gap-1.5">
          <Link href="/import" className="btn btn-ghost"><Icon name="sparkles" className="text-brand-600" />AI import</Link>
          <Link href="/settings" className="icon-btn" aria-label="Settings" title="Settings"><Icon name="settings" className="text-lg" /></Link>
          <button disabled={busy} onClick={() => setNaming({})} className="btn btn-secondary"><Icon name="folderPlus" />New folder</button>
          <button disabled={busy} onClick={newBlank} className="btn btn-primary"><Icon name="plus" />{busy ? "Saving…" : "New notebook"}</button>
        </nav>
      </header>

      <section className="mb-6 flex flex-wrap items-end justify-between gap-4" aria-labelledby="library-title">
        <div className="min-w-0">
          {!!path.length && (
            <nav aria-label="Folders" className="mb-1 flex flex-wrap items-center gap-1 text-sm text-slate-500">
              {[{ id: "", name: "All notebooks" }, ...path.slice(0, -1).map((f) => ({ id: f.id, name: f.data.name }))].map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <button type="button" onClick={() => setFolder(c.id)} {...dropProps(c.id)} className={`rounded-md px-1 hover:text-brand-700 hover:underline ${dropTarget === c.id ? "bg-brand-100 text-brand-800" : ""}`}>{c.name}</button>
                  <Icon name="chevronRight" className="text-slate-400" />
                </span>
              ))}
            </nav>
          )}
          <h2 id="library-title" className="break-words text-3xl font-semibold tracking-tight text-slate-900">{path.at(-1)?.data.name ?? "Your notebooks"}</h2>
          {path.length ? (
            <button type="button" onClick={() => setFolder(path.at(-2)?.id ?? "")} className="mt-1 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-700"><Icon name="back" />Back to {path.at(-2)?.data.name ?? "all notebooks"}</button>
          ) : <p className="mt-1 text-sm text-slate-500">A place to write, practise, and bring your notes together.</p>}
        </div>
        {(!!live?.length || !!folders?.length) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <span className="sr-only">Search notebooks</span>
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input ref={searchInput} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={path.length ? "Search all notebooks…" : "Search by title…"} className="field pl-9" />
            </label>
            <label>
              <span className="sr-only">Sort by</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} className="field w-auto pr-8">
                <option value="recent">Recently edited</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option>
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

      <PdfImport folderId={current} />

      {!!shownFolders.length && (
        <>
          <p className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-slate-400">{shownFolders.length} {shownFolders.length === 1 ? "folder" : "folders"}</p>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shownFolders.map((f) => {
              const n = inside(f.id);
              return (
                <li key={f.id} {...dragProps(f)} {...dropProps(f.id)} className={`card relative transition-shadow hover:shadow-lift ${dropTarget === f.id ? "!border-brand-400 bg-brand-50" : ""}`}>
                  <button type="button" onClick={() => setFolder(f.id)} className="flex w-full items-center gap-3 rounded-2xl py-3 pl-3 pr-28 text-left">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xl text-brand-600"><Icon name="folder" /></span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-900" title={f.data.name}>{f.data.name}</span>
                      <span className="block truncate text-xs text-slate-500">{searching && where(f) ? `In ${where(f)} · ` : ""}{n} {n === 1 ? "item" : "items"}</span>
                    </span>
                  </button>
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-0.5">
                    <button disabled={busy} aria-label={`Move ${f.data.name}`} title="Move" onClick={() => setMoving(f)} className="icon-btn h-8 w-8"><Icon name="folderMove" /></button>
                    <button disabled={busy} aria-label={`Rename ${f.data.name}`} title="Rename" onClick={() => setNaming({ folder: f })} className="icon-btn h-8 w-8"><Icon name="edit" /></button>
                    <button disabled={busy} aria-label={`Delete ${f.data.name}`} title="Delete" onClick={() => setRemovingFolder(f)} className="icon-btn h-8 w-8 hover:!bg-rose-50 hover:!text-rose-600"><Icon name="trash" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!!live?.length && (!!scope.length || searching) && <p role="status" className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-slate-400">{sorted.length} of {scope.length} notebooks</p>}
      {live === undefined || folders === undefined ? <p role="status" className="py-12 text-center text-slate-500">Loading notebooks…</p> : searching && sorted.length === 0 && shownFolders.length === 0 ? (
        <div className="card p-10 text-center">
          <h3 className="font-medium text-slate-900">No matching notebooks</h3>
          <p className="mt-2 text-sm text-slate-500">Try another title or clear your search to see all your notebooks.</p>
          <button onClick={() => { setQuery(""); searchInput.current?.focus(); }} className="btn btn-secondary mt-4">Clear search</button>
        </div>
      ) : sorted.length === 0 && (path.length || folders.length) ? (
        !path.length || shownFolders.length ? null : (
          <div className="mt-8 rounded-2xl border border-dashed border-slate-200 px-6 py-12 text-center">
            <p className="mb-2 font-medium text-slate-900">This folder is empty</p>
            <p className="mx-auto max-w-md text-sm text-slate-500">Import PDFs above or start a notebook here. To bring in notebooks you already have, use the move button on a notebook.</p>
            <button disabled={busy} onClick={newBlank} className="btn btn-primary mt-5"><Icon name="plus" />New notebook</button>
          </div>
        )
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
            <li key={nb.id} {...dragProps(nb)} className="group card relative overflow-hidden transition-shadow hover:shadow-lift">
              <Link href={`/notebook?id=${nb.id}`} className="block rounded-2xl">
                <div className="relative m-3 mb-0 aspect-[16/10] overflow-hidden rounded-xl border border-slate-100 bg-[#fdfdfb]">
                  <NotebookThumb notebookId={nb.id} stamp={edited === undefined ? undefined : edited.get(nb.id) ?? nb.data.createdAt} />
                </div>
                <div className="py-3 pl-4 pr-28">
                  <div className="truncate font-medium text-slate-900" title={nb.data.title}>{nb.data.title}</div>
                  {searching && where(nb) && <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-slate-500"><Icon name="folder" className="shrink-0" /><span className="truncate">{where(nb)}</span></div>}
                  <div className="mt-0.5 text-xs text-slate-500">
                    {counts === undefined ? "…" : (counts.get(nb.id) ?? 0)} {(counts?.get(nb.id) ?? 0) === 1 ? "section" : "sections"} · <span title={`Created ${new Date(nb.data.createdAt).toLocaleDateString()}`}>{edited === undefined ? "…" : formatEdited(edited.get(nb.id) ?? nb.data.createdAt, now)}</span>
                  </div>
                </div>
              </Link>
              <div className="absolute bottom-2.5 right-2 flex gap-0.5">
                <button disabled={busy} aria-label={`Move ${nb.data.title}`} title="Move to folder" onClick={() => setMoving(nb)} className="icon-btn h-8 w-8"><Icon name="folderMove" /></button>
                <button disabled={busy} aria-label={`Rename ${nb.data.title}`} title="Rename" onClick={() => setRenaming(nb)} className="icon-btn h-8 w-8"><Icon name="edit" /></button>
                <button disabled={busy} aria-label={`Delete ${nb.data.title}`} title="Delete" onClick={() => setConfirming(nb)} className="icon-btn h-8 w-8 hover:!bg-rose-50 hover:!text-rose-600"><Icon name="trash" /></button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {renaming && <RenameDialog notebook={renaming} onCancel={() => setRenaming(null)} onRename={(title) => rename(renaming, title)} />}
      {confirming && <DeleteDialog notebook={confirming} onCancel={() => setConfirming(null)} onDelete={() => remove(confirming)} />}
      {naming && <FolderNameDialog folder={naming.folder} onCancel={() => setNaming(null)} onSave={saveFolder} />}
      {moving && <MoveDialog item={moving} folders={folders ?? []} onCancel={() => setMoving(null)} onMove={(to) => move(moving, to)} />}
      {removingFolder && <DeleteFolderDialog folder={removingFolder} items={inside(removingFolder.id)} parent={byId.get(folderOf(removingFolder, byId))?.data.name} onCancel={() => setRemovingFolder(null)} onDelete={() => removeFolder(removingFolder)} />}
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

export function FolderNameDialog({ folder, onCancel, onSave }: { folder?: FolderEntity; onCancel: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(folder?.data.name ?? "");
  return (
    <Dialog title={folder ? "Rename folder" : "New folder"} onClose={onCancel} onSubmit={() => { if (name.trim()) onSave(name.trim()); }}>
      <label className="mt-4 block">
        <span className="sr-only">Folder name</span>
        <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" maxLength={200} className="field" />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={!name.trim()} className="btn btn-primary">{folder ? "Rename" : "Create"}</button>
      </div>
    </Dialog>
  );
}

/** Picks where a notebook or folder goes. A folder can't move into itself or a folder inside it. */
export function MoveDialog({ item, folders, onCancel, onMove }: { item: Item; folders: FolderEntity[]; onCancel: () => void; onMove: (folderId: string) => void }) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const from = folderOf(item, byId);
  const [to, setTo] = useState(from);
  // Depth-first, so each folder sits under its parent.
  const rows: { id: string; name: string; depth: number }[] = [{ id: "", name: "All notebooks (top level)", depth: 0 }];
  const walk = (parent: string, depth: number) => {
    for (const f of sortFolders(folders.filter((f) => folderOf(f, byId) === parent))) {
      if (item.kind === "folder" && f.id === item.id) continue;
      rows.push({ id: f.id, name: f.data.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk("", 1);
  return (
    <Dialog title={`Move “${itemName(item)}”`} onClose={onCancel} onSubmit={() => onMove(to)}>
      <div role="radiogroup" aria-label="Destination folder" className="mt-4 max-h-80 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 p-1">
        {rows.map((r) => (
          <label key={r.id} className={`flex cursor-pointer items-center gap-2 rounded-lg py-2 pr-2 text-sm ${to === r.id ? "bg-brand-50 text-brand-800" : "text-slate-700 hover:bg-slate-50"}`} style={{ paddingLeft: 8 + r.depth * 16 }}>
            <input type="radio" name="destination" checked={to === r.id} onChange={() => setTo(r.id)} className="sr-only" />
            <Icon name={r.id ? "folder" : "notebook"} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {r.id === from && <span className="shrink-0 text-xs text-slate-400">Current</span>}
          </label>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" data-autofocus disabled={to === from} className="btn btn-primary">Move here</button>
      </div>
    </Dialog>
  );
}

export function DeleteFolderDialog({ folder, items, parent, onCancel, onDelete }: { folder: FolderEntity; items: number; parent?: string; onCancel: () => void; onDelete: () => void }) {
  return (
    <Dialog title={`Delete folder “${folder.data.name}”?`} onClose={onCancel} onSubmit={onDelete}>
      <p className="mt-2 break-words text-sm text-slate-500">
        {items ? `Nothing inside is deleted: its ${items === 1 ? "item moves" : `${items} items move`} to ${parent ? `“${parent}”` : "the top level"}.` : "The folder is empty."}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
        <button type="submit" data-autofocus className="btn btn-secondary !border-rose-200 !text-rose-700 hover:!bg-rose-50"><Icon name="trash" />Delete folder</button>
      </div>
    </Dialog>
  );
}
