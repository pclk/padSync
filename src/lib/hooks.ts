"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { getSyncState, subscribeSync } from "./sync";
import { noteSettingWrite, subscribeSettings } from "./device-settings";

import { isLayoutMode, panelWidth, type LayoutMode } from "@/lib/layout-mode";

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

export function useLayoutMode(leftInset = 0) {
  const [stored, setMode] = useStoredState<LayoutMode>("padsync.layoutMode", "half");
  // A mode this version doesn't know (the old "auto") falls back to the split.
  const mode = isLayoutMode(stored) ? stored : "half";
  const [viewport, setViewport] = useState(1024);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return { mode, setMode, width: panelWidth(mode, viewport, leftInset) };
}
