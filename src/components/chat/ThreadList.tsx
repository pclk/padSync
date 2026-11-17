"use client";
import { useState } from "react";
import type { ThreadSummary } from "@/lib/chat-types";
import { Spinner } from "./Spinner";
import { relativeTime, isUnread, type ThreadFilter } from "@/lib/chat-ui";
export interface ThreadListProps {
  now: number;
  threads: ThreadSummary[];
  selected: string;
  seen: Record<string, string>;
  search: string;
  setSearch(s: string): void;
  filter: ThreadFilter;
  setFilter(s: ThreadFilter): void;
  select(id: string): void;
  create(): void;
  action(kind: string, thread: ThreadSummary, title?: string): void;
}
export function ThreadList(p: ThreadListProps) {
  const [menu, setMenu] = useState("");
  const [rename, setRename] = useState("");
  return (
    <div className="space-y-2 p-2">
      <button
        className="w-full rounded-lg bg-slate-900 p-2 text-white"
        onClick={p.create}
      >
        New thread ⌥N
      </button>
      <input
        data-chat-search
        aria-label="Search threads"
        className="w-full rounded-lg border p-2"
        placeholder="Search ⌘K"
        value={p.search}
        onChange={(e) => p.setSearch(e.target.value)}
      />
      <select
        className="w-full"
        aria-label="Filter threads"
        value={p.filter}
        onChange={(e) => p.setFilter(e.target.value as ThreadFilter)}
      >
        <option value="notebook">This notebook</option>
        <option value="all">All</option>
        <option value="archived">Archived</option>
      </select>
      {!p.threads.length && (
        <p className="text-xs text-slate-500">
          {p.search
            ? "No search results. Try another phrase."
            : "No threads yet. Start a conversation about your notebook."}
        </p>
      )}
      {p.threads.map((t, index) => (
        <div
          key={t.id}
          className={`rounded-lg p-2 ${t.id === p.selected ? "bg-slate-200" : "bg-white"}`}
        >
          {t.pinned && !p.threads[index - 1]?.pinned && (
            <p className="mb-2 text-xs font-medium text-slate-500">Pinned</p>
          )}
          {!t.pinned && p.threads[index - 1]?.pinned && (
            <p className="mb-2 text-xs font-medium text-slate-500">
              Conversations
            </p>
          )}
          {rename === t.id ? (
            <input
              aria-label="Rename thread"
              autoFocus
              defaultValue={t.title}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  p.action("rename", t, e.currentTarget.value);
                  setRename("");
                }
                if (e.key === "Escape") setRename("");
              }}
            />
          ) : (
            <button className="w-full text-left" onClick={() => p.select(t.id)}>
              <span className="block truncate font-medium">
                {t.pinned && "⌖ "}
                {t.title || "New thread"} {isUnread(t, p.seen) && "●"}
              </span>
              <span className="block truncate text-xs text-slate-500">
                {t.preview}
              </span>
              <span className="text-xs text-slate-400">
                {relativeTime(t.lastMessageAt ?? t.updatedAt, p.now)}{" "}
                {t.lastStatus === "running" || t.lastStatus === "queued" ? (
                  <Spinner />
                ) : t.lastStatus === "error" ? (
                  <span aria-label="Reply failed" className="text-rose-600">
                    ●
                  </span>
                ) : (
                  ""
                )}
              </span>
            </button>
          )}
          <div
            className="relative text-xs"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMenu("");
                e.currentTarget.querySelector("button")?.focus();
              }
            }}
          >
            <button
              aria-label={`Actions for ${t.title || "New thread"}`}
              aria-expanded={menu === t.id}
              onClick={() => setMenu(menu === t.id ? "" : t.id)}
            >
              •••
            </button>
            {menu === t.id && (
              <div className="z-10 flex flex-wrap gap-2 rounded-lg border bg-white p-2 shadow-sm">
                <button
                  onClick={() => {
                    setRename(t.id);
                    setMenu("");
                  }}
                >
                  Rename
                </button>
                {[
                  t.pinned ? "unpin" : "pin",
                  t.archived ? "unarchive" : "archive",
                  "export",
                  "delete",
                ].map((kind) => (
                  <button
                    key={kind}
                    onClick={() => {
                      p.action(kind, t);
                      setMenu("");
                    }}
                  >
                    {kind === "export"
                      ? "Export Markdown"
                      : kind[0].toUpperCase() + kind.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
