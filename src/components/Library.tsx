"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, deviceId } from "@/lib/db";
import { createNotebook, listNotebooks, putEntities } from "@/lib/store";
import type { NotebookEntity, PresenceEntity } from "@/lib/types";
import { SyncBadge } from "./SyncBadge";

export default function Library() {
  const router = useRouter();
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

  const sorted = [...(notebooks ?? [])].sort((a, b) => b.data.createdAt - a.data.createdAt);
  const ipadNb = ipad && sorted.find((n) => n.id === ipad.notebookId);

  const newBlank = async () => {
    const id = await createNotebook("Untitled notebook");
    router.push(`/notebook?id=${id}`);
  };

  const rename = async (nb: NotebookEntity) => {
    const title = prompt("Rename notebook", nb.data.title);
    if (title?.trim()) await putEntities([{ ...nb, data: { ...nb.data, title: title.trim() } }]);
  };

  const remove = async (nb: NotebookEntity) => {
    if (confirm(`Delete “${nb.data.title}”?`)) await putEntities([{ ...nb, deleted: 1 }]);
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">padSync</h1>
        <SyncBadge />
        <nav className="ml-auto flex gap-2 text-sm">
          <Link href="/import" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">AI import</Link>
          <Link href="/settings" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100">Settings</Link>
          <button onClick={newBlank} className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700">New notebook</button>
        </nav>
      </header>

      {ipadNb && (
        <Link href={`/notebook?id=${ipadNb.id}`} className="mb-6 flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 hover:bg-blue-100">
          <span className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">iPad</span>
          Currently on <strong>{ipadNb.data.title}</strong>. Open and follow →
        </Link>
      )}

      {notebooks === undefined ? null : sorted.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 p-12 text-center text-slate-500">
          <p className="mb-4">No notebooks yet.</p>
          <p className="text-sm">
            Drop your lecture notes into <Link href="/import" className="text-blue-700 underline">AI import</Link> to get notes and practice to write on, or start a blank notebook.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {sorted.map((nb) => (
            <li key={nb.id} className="group relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow">
              <Link href={`/notebook?id=${nb.id}`} className="block">
                <div className="mb-3 aspect-[4/3] rounded-lg bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:14px_14px]" />
                <div className="truncate font-medium text-slate-900">{nb.data.title}</div>
                <div className="text-xs text-slate-500">
                  {counts?.get(nb.id) ?? 0} sections · {new Date(nb.data.createdAt).toLocaleDateString()}
                </div>
              </Link>
              <div className="absolute right-3 top-3 hidden gap-1 group-hover:flex">
                <button onClick={() => rename(nb)} className="rounded bg-white/90 px-2 py-1 text-xs shadow">Rename</button>
                <button onClick={() => remove(nb)} className="rounded bg-white/90 px-2 py-1 text-xs text-rose-600 shadow">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
