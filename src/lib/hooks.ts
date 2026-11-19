"use client";

import { useEffect, useReducer, useState, useSyncExternalStore, type RefObject } from "react";
import { getSyncState, subscribeSync } from "./sync";
import { noteSettingWrite, subscribeSettings } from "./device-settings";

import { onActivity } from "@/lib/activity";
import type { InkController } from "@/ink/controller";
import { layoutReducer, nextTickDelay, panelWidth, type LayoutMode, type LayoutState, type LayoutEvent } from "@/lib/layout-mode";

let snapshot = getSyncState();
const subscribe = (fn: () => void) =>
  subscribeSync(() => {
    snapshot = getSyncState();
    fn();
  });

// Pages are prerendered with no sync state; hydrate with the same, then switch to the client's
// (which remembers lastSyncedAt in localStorage), so the badge's label/tooltip don't mismatch.
const serverSnapshot: ReturnType<typeof getSyncState> = { status: "idle", lastSyncedAt: 0, failures: 0, retryAt: 0, at: 0 };

export function useSyncStatus() {
  return useSyncExternalStore(subscribe, () => snapshot, () => serverSnapshot);
}

export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      const next = JSON.stringify(value);
      const before = localStorage.getItem(key);
      localStorage.setItem(key, next);
      // Automatic: the first save of a default into empty storage is not a change of setting.
      noteSettingWrite(key, before, next, true);
    } catch {}
  }, [key, value]);
  // Settings restored from this device's server copy (device-settings.ts) show straight away.
  useEffect(
    () =>
      subscribeSettings(() => {
        try {
          const raw = localStorage.getItem(key);
          if (raw !== null) setValue((prev) => (JSON.stringify(prev) === raw ? prev : (JSON.parse(raw) as T)));
        } catch {}
      }),
    [key],
  );
  return [value, setValue];
}

// Pencil touches on a drawing surface never scroll (as in NotebookEditor's touch handler); fingers
// still do. iPadOS only honours this from a non-passive touchstart/touchmove listener.
export function usePencilNoScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const claim = (e: TouchEvent) => {
      if ([...e.touches].some((t) => t.touchType === "stylus")) e.preventDefault();
    };
    el.addEventListener("touchstart", claim, { passive: false });
    el.addEventListener("touchmove", claim, { passive: false });
    return () => {
      el.removeEventListener("touchstart", claim);
      el.removeEventListener("touchmove", claim);
    };
  }, [ref]);
}

export function useLayoutMode(notebookId: string, controller: InkController, leftInset = 0) {
  const [mode, persistMode] = useStoredState<LayoutMode>("padsync.layoutMode", "auto");
  const [idleMs] = useStoredState("padsync.layoutIdleMs", 15000);
  const [state, dispatch] = useReducer((s: LayoutState, e: LayoutEvent) => layoutReducer(s, e, idleMs), { mode, effective: mode === "drawing" ? "drawing" : "chat", lastActivityAt: 0, drawingSince: 0 });
  const [viewport, setViewport] = useState(1024);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => onActivity(e => { if (e.notebookId === notebookId) dispatch({ type: "activity", at: e.at }); }), [notebookId]);
  useEffect(() => {
    const delay = nextTickDelay(state, Date.now(), idleMs);
    if (delay === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (controller.isDrawing()) return;
      dispatch({ type: "tick", now: Date.now(), drawing: false });
    };
    const ended = () => { clearTimeout(timer); timer = setTimeout(tick, Math.max(0, nextTickDelay(state, Date.now(), idleMs) ?? 0)); };
    window.addEventListener("pointerup", ended);
    window.addEventListener("pointercancel", ended);
    timer = setTimeout(tick, delay);
    return () => { clearTimeout(timer); window.removeEventListener("pointerup", ended); window.removeEventListener("pointercancel", ended); };
  }, [state, idleMs, controller]);
  const setMode = (value: LayoutMode) => { persistMode(value); dispatch({ type: "setMode", mode: value, now: Date.now() }); };
  return { mode, effective: state.effective, setMode, width: panelWidth(state.effective, viewport, leftInset) };
}
