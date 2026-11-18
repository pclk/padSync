import type { PanelMode } from "@/lib/chat-types";
import { MIN_NOTEBOOK_VIEW } from "@/lib/notebook-viewport";

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
// Share of the window the side panel takes: drawing is a 50/50 split, chat gives the page 25%.
const PANEL_SHARE: Record<PanelMode, number> = { drawing: 0.5, chat: 0.75 };
// Below this the panel stops giving way to the notebook; a window that narrow pans instead.
const MIN_PANEL = 320;
/**
 * The panel's share, but never so wide that less than MIN_NOTEBOOK_VIEW of notebook is left
 * beside it once the tool sidebar (leftInset) has taken its part.
 */
export function panelWidth(effective: PanelMode, viewportWidth: number, leftInset = 0) {
  const share = Math.round(viewportWidth * PANEL_SHARE[effective]);
  const room = viewportWidth - leftInset - MIN_NOTEBOOK_VIEW;
  return Math.max(0, Math.min(share, Math.max(room, Math.min(share, MIN_PANEL))));
}
export function nextTickDelay(state: LayoutState, now: number, idleMs = 15000, minDrawingMs = 4000): number | null {
  return state.mode !== "auto" || state.effective !== "drawing" ? null : Math.max(0, Math.max(state.lastActivityAt + idleMs, state.drawingSince + minDrawingMs) - now);
}
