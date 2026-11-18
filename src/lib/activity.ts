// Edit activity for the adaptive layout (docs/chat-panel-2026-11-17.md). Sync reports edits that
// arrived from another device, the editors report edits made here; the layout listens.
// Presence (where a device is scrolled to) is not activity.

export type ActivityKind = "stroke" | "text" | "section";

export interface ActivityEvent {
  notebookId: string;
  source: "remote" | "local";
  kinds: ActivityKind[];
  at: number;
}

const listeners = new Set<(e: ActivityEvent) => void>();

export function emitActivity(e: ActivityEvent) {
  for (const l of listeners) l(e);
}

export function onActivity(listener: (e: ActivityEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The device that wrote an entity, from its hlc (`<wall>-<counter>-<device>`). */
export const hlcDevice = (hlc: string) => hlc.split("-").slice(2).join("-");

// True while a pen/mouse gesture is on the page, so background work (sync) can wait for the
// stroke to end instead of competing with pointer events for the main thread.
let inking = false;
const inkEndListeners = new Set<() => void>();
export const setInking = (v: boolean) => {
  const ended = inking && !v;
  inking = v;
  if (ended) for (const l of inkEndListeners) l();
};
export const isInking = () => inking;
/** Called when a gesture ends, the gap between strokes where sync can run without competing. */
export function onInkEnd(listener: () => void): () => void {
  inkEndListeners.add(listener);
  return () => inkEndListeners.delete(listener);
}

/** Runs bookkeeping after the current input has been handled and painted. */
export function whenIdle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 1000 });
  else setTimeout(fn, 50);
}
