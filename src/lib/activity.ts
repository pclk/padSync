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
