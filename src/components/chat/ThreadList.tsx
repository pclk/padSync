"use client";
import { useState } from "react";
import type { ThreadSummary } from "@/lib/chat-types";
import { Spinner } from "./Spinner";
import { Icon } from "../Icons";
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
        className="btn btn-primary w-full"
        onClick={p.create}
      >
        <Icon name="plus" />New thread <span className="kbd">⌥N</span>
      </button>
      <input
        data-chat-search
        aria-label="Search threads"
        className="field"
        placeholder="Search ⌘K"
        value={p.search}
        onChange={(e) => p.setSearch(e.target.value)}
      />
      <select
        className="field py-1.5 text-xs"
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
          className={`group/thread relative rounded-xl p-2 transition-colors ${t.id === p.selected ? "bg-white shadow-card ring-1 ring-slate-200" : "hover:bg-white"}`}
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
              className="icon-btn h-6 w-6"
              aria-label={`Actions for ${t.title || "New thread"}`}
              aria-expanded={menu === t.id}
              onClick={() => setMenu(menu === t.id ? "" : t.id)}
            >
              <Icon name="more" />
            </button>
            {menu === t.id && (
              <div className="z-10 mt-1 flex flex-col items-start gap-0.5 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lift [&>button]:w-full [&>button]:rounded-md [&>button]:px-2 [&>button]:py-1 [&>button]:text-left [&>button:hover]:bg-slate-100">
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
