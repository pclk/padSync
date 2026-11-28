"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { noteSettingWrite, notifySettings, subscribeSettings } from "./device-settings";
import { THEME_DEFAULT, THEME_KEY, isThemePreference, type ThemePreference } from "./theme";
import { LASSO_KEY, normalizeLasso, type LassoSettings } from "./lasso-settings";
import { DEFAULT_PROMPTS, PROMPTS_KEY, normalizePrompts, type ChatPrompt } from "./prompts";
import { DEFAULT_GESTURES, DEFAULT_TUNING, GESTURES_KEY, GESTURE_TUNING_KEY, normalizeGestures, normalizeTuning, type GestureBindings, type GestureTuning } from "./touch-gestures";

// App preferences shared by several screens. Stored in localStorage as JSON, like useStoredState,
// but every component reading a setting re-renders when it changes (here or in another tab).

export const SHOW_COPY_BUTTONS_KEY = "padsync.showCopyButtons";
/** The Mac bridge replaced copy-paste into a chat, so the section copy buttons are hidden unless turned on. */
export const SHOW_COPY_BUTTONS_DEFAULT = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseSetting<T>(raw: string | null, fallback: T, valid: (v: unknown) => v is T): T {
  if (raw == null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Reads a setting. Missing, unreadable or invalid values fall back to `fallback`. */
export function readSetting<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    return parseSetting(storage()?.getItem(key) ?? null, fallback, valid);
  } catch {
    return fallback;
  }
}

export function writeSetting<T>(key: string, value: T) {
  const next = JSON.stringify(value);
  try {
    const store = storage();
    const before = store?.getItem(key) ?? null;
    store?.setItem(key, next);
    noteSettingWrite(key, before, next);
  } catch {}
  notifySettings();
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Reads a boolean setting. Missing, unreadable or non-boolean values fall back to `fallback`. */
export const readBoolSetting = (key: string, fallback: boolean) => readSetting(key, fallback, isBool);
export const writeBoolSetting = (key: string, value: boolean) => writeSetting(key, value);

function subscribe(fn: () => void) {
  // A write here, settings restored from the server copy (device-settings.ts), or another tab
  // writing localStorage. useSyncExternalStore skips the re-render if nothing changed.
  const stop = subscribeSettings(fn);
  const onStorage = () => fn();
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    stop();
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useSetting<T>(key: string, fallback: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  // The snapshot is the stored string, not the parsed value: an object parsed afresh on every
  // read would never compare equal, and useSyncExternalStore would re-render forever.
  const read = () => {
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const raw = useSyncExternalStore(subscribe, read, read);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => parseSetting(raw, fallback, valid), [raw]);
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

const isList = (v: unknown): v is unknown[] => Array.isArray(v);

/** The prompts as stored right now, not as some render last saw them. */
export const readPrompts = () => normalizePrompts(readSetting<unknown>(PROMPTS_KEY, DEFAULT_PROMPTS, isList));

/**
 * Changes the stored prompts by applying `change` to them as they are at that moment. A change
 * made from a list a render captured earlier could write back a prompt deleted since, so every
 * edit goes through here.
 */
export const changePrompts = (change: (current: ChatPrompt[]) => ChatPrompt[]) => writeSetting(PROMPTS_KEY, change(readPrompts()));

/** The prompt menu's ready-made chat prompts (see prompts.ts), normalised on read. */
export function usePrompts(): ChatPrompt[] {
  const [raw] = useSetting<unknown>(PROMPTS_KEY, DEFAULT_PROMPTS, isList);
  return useMemo(() => normalizePrompts(raw), [raw]);
}

const isStored = (v: unknown): v is unknown => v !== undefined;

/** The lasso's settings on this device (see lasso-settings.ts), normalised on read. */
/** The lasso tool's icon for its shape (a loop, or a dashed rectangle). */
export function useLassoIcon(): "lasso" | "rectSelect" {
  return useLassoSettings(false)[0].shape === "rect" ? "rectSelect" : "lasso";
}

export function useLassoSettings(ipad: boolean): [LassoSettings, (v: LassoSettings) => void] {
  const [raw, set] = useSetting<unknown>(LASSO_KEY, null, isStored);
  return [useMemo(() => normalizeLasso(raw, ipad), [raw, ipad]), set];
}
