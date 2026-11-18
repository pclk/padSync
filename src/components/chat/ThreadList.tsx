"use client";
import { useState } from "react";
import type { ThreadSummary } from "@/lib/chat-types";
import { Spinner } from "./Spinner";
import { Icon, type IconName } from "../Icons";
import { dateGroup, isUnread, relativeTime, type ThreadFilter } from "@/lib/chat-ui";
import { MenuItem, usePopover } from "./Popover";
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
const FILTERS: [ThreadFilter, string][] = [
  ["notebook", "This notebook"],
  ["all", "All"],
  ["archived", "Archived"],
];

function Row(p: ThreadListProps & { t: ThreadSummary }) {
  const { t } = p;
  const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
  const [renaming, setRenaming] = useState(false);
  const running = t.lastStatus === "running" || t.lastStatus === "queued";
  const items: [string, IconName, string][] = [
    ["rename", "edit", "Rename"],
    [t.pinned ? "unpin" : "pin", "pin", t.pinned ? "Unpin" : "Pin"],
    [t.archived ? "unarchive" : "archive", "archive", t.archived ? "Unarchive" : "Archive"],
    ["export", "download", "Export Markdown"],
    ["delete", "trash", "Delete"],
  ];
  return (
    <div
      ref={menuRef}
      className={`group/thread relative flex items-center rounded-lg transition-colors ${t.id === p.selected ? "bg-slate-200/70" : "hover:bg-slate-100"}`}
    >
      {renaming ? (
        <input
          aria-label="Rename thread"
          autoFocus
          className="field m-0.5 h-8 py-0 text-sm"
          defaultValue={t.title}
          onBlur={() => setRenaming(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              p.action("rename", t, e.currentTarget.value);
              setRenaming(false);
            }
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <button
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left"
          title={[t.preview, relativeTime(t.lastMessageAt ?? t.updatedAt, p.now)].filter(Boolean).join(" · ")}
          onClick={() => p.select(t.id)}
        >
          <span className={`min-w-0 flex-1 truncate text-sm ${t.id === p.selected ? "font-medium text-slate-900" : "text-slate-700"}`}>
            {t.title || "New chat"}
          </span>
          {running ? (
            <Spinner />
          ) : t.lastStatus === "error" ? (
            <span aria-label="Reply failed" className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-600" />
          ) : isUnread(t, p.seen) && t.id !== p.selected ? (
            <span aria-label="Unread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" />
          ) : null}
        </button>
      )}
      {!renaming && (
        <button
          data-popover-trigger
          className={`icon-btn mr-0.5 h-7 w-7 shrink-0 rounded-md ${menuOpen ? "" : "opacity-0 focus:opacity-100 group-hover/thread:opacity-100"}`}
          aria-label={`Actions for ${t.title || "New chat"}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name="more" />
        </button>
      )}
      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lift">
          {items.map(([kind, icon, label]) => (
            <MenuItem
              key={kind}
              danger={kind === "delete"}
              onClick={() => {
                setMenuOpen(false);
                if (kind === "rename") setRenaming(true);
                else p.action(kind, t);
              }}
            >
              <Icon name={icon} /> {label}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreadList(p: ThreadListProps) {
  const groups = p.threads.map((t) => dateGroup(t, p.now));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-2">
        <button
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100"
          onClick={p.create}
        >
          <Icon name="compose" /> New chat <span className="kbd ml-auto">⌥N</span>
        </button>
        <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
          <Icon name="search" className="shrink-0 text-slate-400" />
          <input
            data-chat-search
            aria-label="Search threads"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            placeholder="Search chats"
            value={p.search}
            onChange={(e) => p.setSearch(e.target.value)}
          />
          <span className="kbd">⌘K</span>
        </label>
        <div className="segmented flex w-full" role="tablist" aria-label="Filter threads">
          {FILTERS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={p.filter === v} className="flex-1 justify-center !px-1 text-xs" onClick={() => p.setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!p.threads.length && (
          <p className="px-2.5 py-6 text-center text-xs text-slate-500">
            {p.search ? "No chats match. Try another phrase." : "No chats yet."}
          </p>
        )}
        {p.threads.map((t, i) => {
          const g = groups[i];
          const heading = g !== groups[i - 1];
          return (
            <div key={t.id}>
              {heading && <p className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g}</p>}
              <Row {...p} t={t} />
            </div>
          );
        })}
      </nav>
    </div>
  );
}
