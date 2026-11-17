import Dexie, { type Table } from "dexie";
import type { DeviceKind, Entity, PadEvent } from "./types";

export interface Meta {
  key: string;
  value: unknown;
}

class PadDB extends Dexie {
  entities!: Table<Entity, string>;
  events!: Table<PadEvent, string>;
  meta!: Table<Meta, string>;

  constructor() {
    super("padsync");
    this.version(1).stores({
      entities: "id, kind, dirty, [notebookId+kind], [parentId+kind]",
      events: "id, synced, notebookId, sectionId, t",
      meta: "key",
    });
    // Erased ink is kept forever (soft delete), so the per-section queries that re-run on every
    // stroke read only live rows via [parentId+kind+deleted]. [sectionId+type] lets the side
    // panel count a section's visits without scanning its events.
    this.version(2).stores({
      entities: "id, kind, dirty, [notebookId+kind], [parentId+kind], [parentId+kind+deleted]",
      events: "id, synced, notebookId, sectionId, t, [sectionId+type]",
    });
  }
}

export const db = new PadDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}

let cachedDevice: string | null = null;

/** Stable per-browser id, used in clocks, events and presence. */
export function deviceId(): string {
  if (cachedDevice) return cachedDevice;
  try {
    cachedDevice = localStorage.getItem("padsync.device");
  } catch {}
  if (!cachedDevice) {
    cachedDevice = Math.random().toString(36).slice(2, 10);
    try {
      localStorage.setItem("padsync.device", cachedDevice);
    } catch {}
  }
  return cachedDevice;
}

export function deviceKind(): DeviceKind {
  if (typeof navigator === "undefined") return "desktop";
  // iPadOS reports itself as a Mac; touch points give it away.
  const isIpad = /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIpad ? "ipad" : "desktop";
}
