"use client";

import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { getSyncState, subscribeSync } from "./sync";

import { onActivity } from "@/lib/activity";
import type { InkController } from "@/ink/controller";
import { layoutReducer, nextTickDelay, panelWidth, type LayoutMode, type LayoutState, type LayoutEvent } from "@/lib/layout-mode";

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

export function useLayoutMode(notebookId: string, controller: InkController) {
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
  return { mode, effective: state.effective, setMode, width: panelWidth(state.effective, viewport) };
}
