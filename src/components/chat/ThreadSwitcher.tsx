"use client";
import { ThreadList, type ThreadListProps } from "./ThreadList";
export function ThreadSwitcher(p: ThreadListProps) {
  return <details data-chat-switcher className="shrink-0 border-b"><summary className="cursor-pointer p-2">Threads · {p.threads.find((t) => t.id === p.selected)?.title || "New thread"}</summary><div className="max-h-64 overflow-y-auto"><ThreadList {...p} /></div></details>;
}
