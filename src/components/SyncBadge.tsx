"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useSyncStatus } from "@/lib/hooks";
import { retrySyncNow } from "@/lib/sync";
import { announcedView, describeSync, syncAnnouncement, type SyncView } from "@/lib/sync-status";
import { Icon } from "./Icons";

// Self-contained: it subscribes to the sync engine and ticks its own countdown, so a status change
// re-renders only this badge, never the toolbar or the editor around it.

export function SyncBadge({ align = "end" }: { align?: "start" | "end" }) {
  const state = useSyncStatus();
  const [tick, setTick] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const now = Math.max(tick, state.at);
  const d = describeSync(state, now);

  // The live region follows settled states only (see announcedView); updated during render, React's
  // pattern for state derived from the previous render.
  const [announced, setAnnounced] = useState<SyncView | null>(null);
  const nextAnnounced = announcedView(announced, d.view);
  if (nextAnnounced !== announced) setAnnounced(nextAnnounced);

  const ticking = open || d.countdown !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside, { passive: true });
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const tooltip = `${d.label} · ${d.lastSynced}`;
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
        title={tooltip}
        aria-label={`Sync status: ${d.label}. ${d.lastSynced}. Show details`}
        aria-expanded={open}
        aria-controls={popoverId}
        data-sync-view={d.view}
        onClick={() => { setTick(Date.now()); setOpen(o => !o); }}
      >
        <Icon name={d.icon} className={`text-sm ${d.tone} ${d.view === "syncing" ? "motion-safe:animate-spin" : ""}`} />
        <span className="hidden tabular-nums lg:inline">{d.label}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announced ? syncAnnouncement(announced) : ""}
      </span>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Sync status"
          className={`card absolute top-full z-50 mt-2 w-72 p-3 text-sm shadow-lift ${align === "end" ? "right-0" : "left-0"}`}
        >
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <Icon name={d.icon} className={d.tone} />
            <span className="tabular-nums">{d.label}</span>
          </div>
          <p className="mt-1.5 text-slate-600">{d.explain}</p>
          <p className="mt-2 text-xs text-slate-500">{d.lastSynced}</p>
          {d.view === "failed" && d.countdown !== null && (
            <p className="mt-0.5 text-xs tabular-nums text-slate-500">Next automatic try in {d.countdown} s</p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Link href="/settings" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Sync settings</Link>
            {d.canRetry && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => retrySyncNow()}>
                <Icon name="refresh" />Retry now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
