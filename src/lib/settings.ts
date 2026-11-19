"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { THEME_DEFAULT, THEME_KEY, isThemePreference, type ThemePreference } from "./theme";
import { DEFAULT_GESTURES, DEFAULT_TUNING, GESTURES_KEY, GESTURE_TUNING_KEY, normalizeGestures, normalizeTuning, type GestureBindings, type GestureTuning } from "./touch-gestures";

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

/** Reads a setting. Missing, unreadable or invalid values fall back to `fallback`. */
export function readSetting<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = storage()?.getItem(key);
    if (raw == null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting<T>(key: string, value: T) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {}
  listeners.forEach((fn) => fn());
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Reads a boolean setting. Missing, unreadable or non-boolean values fall back to `fallback`. */
export const readBoolSetting = (key: string, fallback: boolean) => readSetting(key, fallback, isBool);
export const writeBoolSetting = (key: string, value: boolean) => writeSetting(key, value);

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

export function useSetting<T>(key: string, fallback: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const read = () => readSetting(key, fallback, valid);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((v: T) => writeSetting(key, v), [key]);
  return [value, set];
}

export const useBoolSetting = (key: string, fallback: boolean) => useSetting(key, fallback, isBool);

export const useShowCopyButtons = () => useBoolSetting(SHOW_COPY_BUTTONS_KEY, SHOW_COPY_BUTTONS_DEFAULT);

export const SYNC_DEBUG_KEY = "padsync.syncDebug";
export const SYNC_DEBUG_DEFAULT = false;
export const useSyncDebug = () => useBoolSetting(SYNC_DEBUG_KEY, SYNC_DEBUG_DEFAULT);

export const readThemePreference = () => readSetting(THEME_KEY, THEME_DEFAULT, isThemePreference);
export const writeThemePreference = (v: ThemePreference) => writeSetting(THEME_KEY, v);
export const useThemePreference = () => useSetting(THEME_KEY, THEME_DEFAULT, isThemePreference);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What each finger gesture does on the iPad (see touch-gestures), normalised on read. */
export function useGestureBindings(): [GestureBindings, (v: GestureBindings) => void] {
  const [raw, set] = useSetting<Partial<GestureBindings>>(GESTURES_KEY, DEFAULT_GESTURES, isObject);
  return [useMemo(() => normalizeGestures(raw), [raw]), set];
}

/** How the gestures are told apart: hold time, stillness, tap length and so on. */
export function useGestureTuning(): [GestureTuning, (v: GestureTuning) => void] {
  const [raw, set] = useSetting<Partial<GestureTuning>>(GESTURE_TUNING_KEY, DEFAULT_TUNING, isObject);
  return [useMemo(() => normalizeTuning(raw), [raw]), set];
}
