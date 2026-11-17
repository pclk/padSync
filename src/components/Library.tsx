"use client";
import PdfImport from "./PdfImport";
import { forgetPdf } from "@/lib/pdf";

import { useRef, useState } from "react";
import { selectNotebooks, type LibrarySort } from "@/lib/library";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, deviceId } from "@/lib/db";
import { createNotebook, listNotebooks, putEntities } from "@/lib/store";
import type { NotebookEntity, PresenceEntity, SectionData } from "@/lib/types";
import { SyncBadge } from "./SyncBadge";

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

  const sorted = selectNotebooks(notebooks ?? [], query, sort);
  const ipadNb = ipad && notebooks?.find((n) => n.id === ipad.notebookId);

  const newBlank = () => mutate(async () => {
    const id = await createNotebook("Untitled notebook");
    router.push(`/notebook?id=${id}`);
  });

  const rename = async (nb: NotebookEntity) => {
    const title = prompt("Rename notebook", nb.data.title);
    if (title?.trim()) await mutate(async () => { await putEntities([{ ...nb, data: { ...nb.data, title: title.trim() } }]); });
  };

  const remove = async (nb: NotebookEntity) => {
    if (!confirm(`Delete “${nb.data.title}”?`)) return;
    await mutate(async () => { await putEntities([{ ...nb, deleted: 1 }]); });
    // The server removes stored PDFs of deleted notebooks; this device's copy goes now.
    const secs = await db.entities.where("[notebookId+kind]").equals([nb.id, "section"]).toArray();
    for (const id of new Set(secs.flatMap((s) => (s.data as SectionData).pdf?.documentId ?? []))) await forgetPdf(id).catch(() => {});
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">padSync</h1>
        <SyncBadge />
        <nav aria-label="Library" className="flex w-full flex-wrap gap-2 text-sm sm:ml-auto sm:w-auto">
          <Link href="/import" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">AI import</Link>
          <Link href="/settings" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">Settings</Link>
          <button disabled={busy} onClick={newBlank} className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 disabled:opacity-50">{busy ? "Saving…" : "New notebook"}</button>
        </nav>
      </header>

      <PdfImport />
      <section className="mb-6" aria-labelledby="library-title">
        <h2 id="library-title" className="text-2xl font-semibold tracking-tight">Your notebooks</h2>
        <p className="mt-1 text-sm text-slate-500">A place to write, practise, and bring your notes together.</p>
      </section>
      {error && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}
      {ipadNb && (
        <Link href={`/notebook?id=${ipadNb.id}`} className="mb-6 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 hover:bg-blue-100">
          <span className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">iPad</span>
          <span className="min-w-0 break-words">Currently on <strong>{ipadNb.data.title}</strong>. Open and follow →</span>
        </Link>
      )}

      {!!notebooks?.length && (
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1 text-sm font-medium text-slate-600">Search notebooks
            <input ref={searchInput} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title…" className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900" />
          </label>
          <label className="text-sm font-medium text-slate-600">Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900">
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="title">Title A–Z</option>
            </select>
          </label>
          <p role="status" className="w-full text-xs text-slate-500">{sorted.length} of {notebooks.length} notebooks</p>
        </div>
      )}
      {notebooks === undefined ? <p role="status" className="py-12 text-center text-slate-500">Loading notebooks…</p> : notebooks.length > 0 && sorted.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <h3 className="font-medium">No matching notebooks</h3>
          <p className="mt-2 text-sm text-slate-500">Try another title or clear your search to see all your notebooks.</p>
          <button onClick={() => { setQuery(""); searchInput.current?.focus(); }} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm">Clear search</button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 p-12 text-center text-slate-500">
          <p className="mb-4 text-lg font-medium text-slate-900">Start your first notebook</p>
          <p className="text-sm">
            Drop your lecture notes into <Link href="/import" className="text-blue-700 underline">AI import</Link> to get notes and practice to write on, or start a blank notebook.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          {sorted.map((nb) => (
            <li key={nb.id} className="group relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow">
              <Link href={`/notebook?id=${nb.id}`} className="block rounded-lg">
                <div className="mb-3 aspect-[4/3] rounded-lg bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:14px_14px]" />
                <div className="truncate font-medium text-slate-900" title={nb.data.title}>{nb.data.title}</div>
                <div className="text-xs text-slate-500">
                  {counts === undefined ? "…" : (counts.get(nb.id) ?? 0)} {(counts?.get(nb.id) ?? 0) === 1 ? "section" : "sections"} · {new Date(nb.data.createdAt).toLocaleDateString()}
                </div>
              </Link>
              <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
                <button disabled={busy} aria-label={`Rename ${nb.data.title}`} onClick={() => rename(nb)} className="rounded bg-white/90 px-3 py-2 text-xs shadow">Rename</button>
                <button disabled={busy} aria-label={`Delete ${nb.data.title}`} onClick={() => remove(nb)} className="rounded bg-white/90 px-3 py-2 text-xs text-rose-600 shadow">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
