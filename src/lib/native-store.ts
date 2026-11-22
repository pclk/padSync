// Phase 4 groundwork: inside the native iPad app the web screens can read and write the app's
// own SQLite store (ios/PadSync/Web/StoreBridge.swift) instead of waiting for the server to carry
// native ink into Dexie. The app sets `window.padsyncNative.store` and answers on the
// `padsyncStore` message handler; each postMessage returns a promise with the reply.
// Nothing uses this yet: it is the adapter the library will switch to.

import type { Entity, EntityKind } from "./types";

interface ReplyHandler { postMessage(message: unknown): Promise<unknown> }

interface NativeWindow {
  padsyncNative?: { version?: number; store?: boolean };
  webkit?: { messageHandlers?: { padsyncStore?: ReplyHandler } };
}

export const NATIVE_CHANGE_EVENT = "padsync-native-change";

export interface ListOptions {
  kind?: EntityKind;
  parentId?: string;
  includeDeleted?: boolean;
}

export interface NativeStore {
  get(id: string): Promise<Entity | undefined>;
  list(notebookId: string, options?: ListOptions): Promise<Entity[]>;
  notebooks(): Promise<Entity<"notebook">[]>;
  /** The app stamps a fresh hlc, marks the rows dirty and syncs them; resolves to what it stored. */
  put(entities: Entity[]): Promise<Entity[]>;
  /** Calls back whenever the native store changes (local writes or sync). Returns an unsubscribe. */
  onChange(callback: () => void): () => void;
}

/** The native store, or null outside the app (or in an app build without the store bridge). */
export function nativeStore(win: unknown = typeof window === "undefined" ? undefined : window): NativeStore | null {
  const w = win as (NativeWindow & Pick<Window, "addEventListener" | "removeEventListener">) | undefined;
  const handler = w?.webkit?.messageHandlers?.padsyncStore;
  if (!w || !handler || !w.padsyncNative?.store) return null;
  const call = (message: Record<string, unknown>) => handler.postMessage(message);
  return {
    async get(id) {
      return ((await call({ op: "get", id })) as Entity | null) ?? undefined;
    },
    async list(notebookId, options = {}) {
      return (await call({ op: "list", notebookId, ...options })) as Entity[];
    },
    async notebooks() {
      return (await call({ op: "notebooks" })) as Entity<"notebook">[];
    },
    async put(entities) {
      if (entities.length === 0) return [];
      return (await call({ op: "put", entities })) as Entity[];
    },
    onChange(callback) {
      const listener = () => callback();
      w.addEventListener(NATIVE_CHANGE_EVENT, listener);
      return () => w.removeEventListener(NATIVE_CHANGE_EVENT, listener);
    },
  };
}
