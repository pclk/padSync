import type { PanelMode } from "@/lib/chat-types";

export type LayoutMode = "auto" | PanelMode;
export interface LayoutState { mode: LayoutMode; effective: PanelMode; lastActivityAt: number; drawingSince: number }
export type LayoutEvent = { type: "activity"; at: number } | { type: "tick"; now: number; drawing: boolean } | { type: "setMode"; mode: LayoutMode; now: number } | { type: "init"; now: number; lastActivityAt: number };
export function layoutReducer(state: LayoutState, event: LayoutEvent, idleMs = 15000, minDrawingMs = 4000): LayoutState {
  if (event.type === "setMode") {
    const effective = event.mode === "auto" ? (event.now - state.lastActivityAt >= idleMs ? "chat" : "drawing") : event.mode;
    return { ...state, mode: event.mode, effective, drawingSince: effective === "drawing" ? event.now : state.drawingSince };
  }
  if (state.mode !== "auto") return state;
  if (event.type === "init") return { ...state, lastActivityAt: event.lastActivityAt, effective: event.now - event.lastActivityAt >= idleMs ? "chat" : "drawing", drawingSince: event.now };
  if (event.type === "activity") return { ...state, effective: "drawing", lastActivityAt: event.at, drawingSince: state.effective === "drawing" ? state.drawingSince : event.at };
  if (!event.drawing && event.now >= Math.max(state.lastActivityAt + idleMs, state.drawingSince + minDrawingMs)) return { ...state, effective: "chat" };
  return state;
}
export function panelWidth(effective: PanelMode, viewportWidth: number) {
  return effective === "drawing" ? 360 : Math.max(0, Math.min(Math.max(420, viewportWidth / 2), viewportWidth - 480));
}
export function nextTickDelay(state: LayoutState, now: number, idleMs = 15000, minDrawingMs = 4000): number | null {
  return state.mode !== "auto" || state.effective !== "drawing" ? null : Math.max(0, Math.max(state.lastActivityAt + idleMs, state.drawingSince + minDrawingMs) - now);
}
