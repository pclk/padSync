import { db, getMeta, setMeta } from "./db";
import { hlcObserve } from "./hlc";
import type { Entity } from "./types";

// Offline-first sync. Local writes land in IndexedDB marked dirty; this engine pushes them
// (debounced) and pulls everything the server has seen since our cursor. The same POST does
// both, so one round trip per tick. Transport is plain HTTP polling for now; a realtime
// "new data" ping can later just call requestSync().

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "local-only" | "needs-login" | "error";

const PUSH_DEBOUNCE_MS = 400;
const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 15000;
// Strokes are a few KB each; keep requests well under Vercel's 4.5 MB body limit.
const ENTITY_BATCH = 100;
const EVENT_BATCH = 500;

let status: SyncStatus = "idle";
let lastSyncedAt = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;
let started = false;

export function getSyncState() {
  return { status, lastSyncedAt };
}

export function subscribeSync(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setStatus(s: SyncStatus) {
  status = s;
  if (s === "synced") lastSyncedAt = Date.now();
  listeners.forEach((l) => l());
}

export function requestSync(delay = PUSH_DEBOUNCE_MS) {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(runSync, delay);
}

export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  pollLoop = () => requestSync(document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  window.addEventListener("online", () => requestSync(0));
  document.addEventListener("visibilitychange", () => requestSync(0));
  requestSync(0);
}

let pollLoop: (() => void) | null = null;

async function runSync() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    let more = true;
    while (more) more = await syncOnce();
  } finally {
    running = false;
    if (again) {
      again = false;
      requestSync(0);
    } else {
      pollLoop?.();
    }
  }
}

/** One push+pull round trip; true when there is more to do. Exported for tests. */
export async function syncOnce(): Promise<boolean> {
  if (!navigator.onLine) {
    setStatus("offline");
    return false;
  }
  const [dirty, events, since] = await Promise.all([
    db.entities.where("dirty").equals(1).limit(ENTITY_BATCH).toArray(),
    db.events.where("synced").equals(0).limit(EVENT_BATCH).toArray(),
    getMeta<number>("cursor").then((c) => c ?? 0),
  ]);
  if (status !== "synced" || dirty.length || events.length) setStatus("syncing");

  let res: Response;
  try {
    res = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        since,
        changes: dirty.map((e) => ({ ...e, dirty: undefined })),
        events: events.map((e) => ({ ...e, synced: undefined })),
      }),
    });
  } catch {
    setStatus("offline");
    return false;
  }
  if (res.status === 401) {
    setStatus("needs-login");
    return false;
  }
  if (res.status === 503) {
    setStatus("local-only");
    return false;
  }
  if (!res.ok) {
    setStatus("error");
    return false;
  }

  const body = (await res.json()) as { changes: Omit<Entity, "dirty">[]; cursor: number; more: boolean };

  await db.transaction("rw", db.entities, db.events, db.meta, async () => {
    // Clear dirty only if the row was not rewritten while the request was in flight.
    const current = await db.entities.bulkGet(dirty.map((e) => e.id));
    const acked = dirty.filter((sent, i) => current[i]?.hlc === sent.hlc);
    if (acked.length) await db.entities.bulkUpdate(acked.map((e) => ({ key: e.id, changes: { dirty: 0 as const } })));
    if (events.length) await db.events.bulkUpdate(events.map((e) => ({ key: e.id, changes: { synced: 1 as const } })));
    if (body.changes.length) {
      const locals = await db.entities.bulkGet(body.changes.map((r) => r.id));
      const newer = body.changes.filter((remote, i) => {
        hlcObserve(remote.hlc);
        const local = locals[i];
        return !local || remote.hlc > local.hlc;
      });
      if (newer.length) await db.entities.bulkPut(newer.map((r) => ({ ...r, dirty: 0 as const })));
    }
    await db.meta.put({ key: "cursor", value: body.cursor });
  });

  setStatus("synced");
  return body.more || dirty.length === ENTITY_BATCH || events.length === EVENT_BATCH;
}

export async function resetCursor() {
  await setMeta("cursor", 0);
  requestSync(0);
}
