"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getSyncState, subscribeSync } from "./sync";

let snapshot = getSyncState();
const subscribe = (fn: () => void) =>
  subscribeSync(() => {
    snapshot = getSyncState();
    fn();
  });

export function useSyncStatus() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
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
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}
