"use client";
import { useEffect } from "react";
import { ThreadList, type ThreadListProps } from "./ThreadList";
import { Icon } from "../Icons";
import { usePopover } from "./Popover";

/** Narrow (drawing) layout: the chat title opens the thread list as a dropdown. */
export function ThreadSwitcher(p: ThreadListProps & { title: string }) {
  const { open, setOpen, ref } = usePopover();
  // ⌘K opens it: useChat dispatches chat-open-switcher on this element.
  useEffect(() => {
    const el = ref.current;
    const request = () => setOpen(true);
    el?.addEventListener("chat-open-switcher", request);
    return () => el?.removeEventListener("chat-open-switcher", request);
  }, [ref, setOpen]);
  return (
    <div ref={ref} data-chat-switcher className="relative min-w-0 flex-1">
      <button
        data-popover-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-8 max-w-full items-center gap-1 rounded-lg px-2 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-100 aria-expanded:bg-slate-100"
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">{p.title || "New chat"}</span>
        <Icon name="chevronDown" className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <div role="dialog" aria-label="Chats" className="absolute left-0 top-full z-40 mt-1 h-[min(28rem,70vh)] w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift">
          <ThreadList
            {...p}
            select={(id) => {
              p.select(id);
              setOpen(false);
            }}
            create={() => {
              p.create();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
