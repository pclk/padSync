"use client";
import { ThreadList, type ThreadListProps } from "./ThreadList";
export function ThreadSwitcher(p: ThreadListProps) {
  return (
    <details data-chat-switcher className="shrink-0 border-b border-slate-200">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        Threads ·{" "}
        {p.threads.find((t) => t.id === p.selected)?.title || "New thread"}
      </summary>
      <div className="max-h-64 overflow-y-auto">
        <ThreadList {...p} />
      </div>
    </details>
  );
}
