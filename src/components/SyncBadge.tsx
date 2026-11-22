"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useSyncStatus } from "@/lib/hooks";
import { retrySyncNow } from "@/lib/sync";
import { announcedView, describeSync, syncAnnouncement, type SyncView } from "@/lib/sync-status";
import { Icon } from "./Icons";

// Self-contained: it subscribes to the sync engine and ticks its own countdown, so a status change
// re-renders only this badge, never the toolbar or the editor around it.

/** `side`: the details open beside the badge, fixed, so a scrolling sidebar doesn't clip them.
 *  `showLabel`: always name the state, not only on wide screens. */
export function SyncBadge({ align = "end", side = false, showLabel = false }: { align?: "start" | "end"; side?: boolean; showLabel?: boolean }) {
  const state = useSyncStatus();
  const [tick, setTick] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
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
        onClick={() => { setTick(Date.now()); if (side) setPlace(sidePlace(wrap.current)); setOpen(o => !o); }}
      >
        <Icon name={d.icon} className={`text-sm ${d.tone} ${d.view === "syncing" ? "motion-safe:animate-spin" : ""}`} />
        <span className={`tabular-nums ${showLabel ? "" : "hidden lg:inline"}`}>{d.label}</span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announced ? syncAnnouncement(announced) : ""}
      </span>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Sync status"
          className={`card z-50 w-72 p-3 text-sm shadow-lift ${side ? "fixed" : `absolute top-full mt-2 ${align === "end" ? "right-0" : "left-0"}`}`}
          style={side ? place : undefined}
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

/** Beside the badge, to its right, kept on screen. */
function sidePlace(el: HTMLElement | null): CSSProperties | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { left: r.right + 8, top: Math.max(8, Math.min(r.top, window.innerHeight - 220)) };
}
