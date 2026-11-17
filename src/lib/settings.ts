"use client";

import { useCallback, useSyncExternalStore } from "react";

// App preferences shared by several screens. Stored in localStorage as JSON, like useStoredState,
// but every component reading a setting re-renders when it changes (here or in another tab).

export const SHOW_COPY_BUTTONS_KEY = "padsync.showCopyButtons";
/** The Mac bridge replaced copy-paste into a chat, so the section copy buttons are hidden unless turned on. */
export const SHOW_COPY_BUTTONS_DEFAULT = false;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads a boolean setting. Missing, unreadable or non-boolean values fall back to `fallback`. */
export function readBoolSetting(key: string, fallback: boolean): boolean {
  try {
    const raw = storage()?.getItem(key);
    if (raw == null) return fallback;
    const v: unknown = JSON.parse(raw);
    return typeof v === "boolean" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeBoolSetting(key: string, value: boolean) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {}
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab wrote localStorage. useSyncExternalStore skips the re-render if nothing changed.
  const onStorage = () => fn();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useBoolSetting(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const read = () => readBoolSetting(key, fallback);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((v: boolean) => writeBoolSetting(key, v), [key]);
  return [value, set];
}

export const useShowCopyButtons = () => useBoolSetting(SHOW_COPY_BUTTONS_KEY, SHOW_COPY_BUTTONS_DEFAULT);

export const SYNC_DEBUG_KEY = "padsync.syncDebug";
export const SYNC_DEBUG_DEFAULT = false;
export const useSyncDebug = () => useBoolSetting(SYNC_DEBUG_KEY, SYNC_DEBUG_DEFAULT);
