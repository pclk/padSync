"use client";
import { useState } from "react";
import type { ThreadSummary } from "@/lib/chat-types";
import { isUnread, type ThreadFilter } from "@/lib/chat-ui";
export interface ThreadListProps { threads: ThreadSummary[]; selected: string; seen: Record<string, string>; search: string; setSearch(s: string): void; filter: ThreadFilter; setFilter(s: ThreadFilter): void; select(id: string): void; create(): void; action(kind: string, thread: ThreadSummary, title?: string): void }
export function ThreadList(p: ThreadListProps) {
  const [now] = useState(() => Date.now());
  const [rename, setRename] = useState("");
  return <div className="space-y-2 p-2"><button className="w-full rounded-lg bg-slate-900 p-2 text-white" onClick={p.create}>New thread ⌥N</button><input data-chat-search aria-label="Search threads" className="w-full rounded-lg border p-2" placeholder="Search ⌘K" value={p.search} onChange={(e) => p.setSearch(e.target.value)} /><select className="w-full" aria-label="Filter threads" value={p.filter} onChange={(e) => p.setFilter(e.target.value as ThreadFilter)}><option value="notebook">This notebook</option><option value="all">All</option><option value="archived">Archived</option></select>
    {!p.threads.length && <p className="text-xs text-slate-500">No threads found.</p>}{p.threads.map((t) => <div key={t.id} className={`rounded-lg p-2 ${t.id === p.selected ? "bg-slate-200" : "bg-white"}`}>
      {rename === t.id ? <input aria-label="Rename thread" autoFocus defaultValue={t.title} onKeyDown={(e) => { if (e.key === "Enter") { p.action("rename", t, e.currentTarget.value); setRename(""); } if (e.key === "Escape") setRename(""); }} /> : <button className="w-full text-left" onClick={() => p.select(t.id)}><span className="block truncate font-medium">{t.pinned && "⌖ "}{t.title || "New thread"} {isUnread(t, p.seen) && "●"}</span><span className="block truncate text-xs text-slate-500">{t.preview}</span><span className="text-xs text-slate-400">{Math.max(0, Math.floor((now - Date.parse(t.lastMessageAt ?? t.updatedAt)) / 60000))}m ago {t.lastStatus === "running" || t.lastStatus === "queued" ? "◌" : t.lastStatus === "error" ? "🔴" : ""}</span></button>}
      <details className="text-xs"><summary aria-label={`Actions for ${t.title}`}>•••</summary><div className="flex flex-wrap gap-2"><button onClick={() => setRename(t.id)}>Rename</button>{[t.pinned ? "unpin" : "pin", t.archived ? "unarchive" : "archive", "export", "delete"].map((kind) => <button key={kind} onClick={() => p.action(kind, t)}>{kind}</button>)}</div></details>
    </div>)}
  </div>;
}
