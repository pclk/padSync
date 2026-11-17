import { DEFAULT_DEBOUNCE_MS, validDebounce, DEFAULT_SYNC_CONFIG, normalizeSyncConfig, type SyncConfig } from "./sync-policy";
import { db, getMeta, setMeta } from "./db";
import { hlcObserve } from "./hlc";
import type { Entity } from "./types";

// Offline-first sync. Local writes land in IndexedDB marked dirty; this engine pushes them
// (debounced) and pulls everything the server has seen since our cursor. The same POST does
// both, so one round trip per tick. Transport is plain HTTP polling for now; a realtime
// "new data" ping can later just call requestSync().

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "local-only" | "needs-login" | "error";

let debounceMs = DEFAULT_DEBOUNCE_MS;
let config = { ...DEFAULT_SYNC_CONFIG };
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
let dueAt = Infinity;
let failures = 0;
let retryAt = 0;
let configCheckedAt = -Infinity;
let configLoading = false;
const observedSince = Date.now();
const editTimes: number[] = [];
const requestTimes: number[] = [];
let traceTruncated = false;
export function getSyncTiming() {
  const now = Date.now(), start = Math.max(observedSince, now - 300000);
  return { ...config, debounceMs, start, end: now, edits: editTimes.filter(t => t >= start), requests: requestTimes.filter(t => t >= start).length, traceTruncated };
}
export function setSyncDebounce(value: number) {
  if (validDebounce(value)) setSyncConfig({ ...config, debounceMs: value });
}
export function setSyncConfig(value: Partial<SyncConfig>) {
  config = normalizeSyncConfig({ ...config, ...value });
  debounceMs = config.debounceMs;
  // A faster configuration advances an existing poll without delaying queued writes.
  if (started) schedule(document.visibilityState === 'visible' ? config.visiblePollMs : config.hiddenPollMs);
}
function record(trace: number[]) {
  const now = Date.now();
  while (trace.length && trace[0] < now - 300000) trace.shift();
  trace.push(now);
  if (trace.length > 10000) { trace.shift(); traceTruncated = true; }
}
async function refreshConfig() {
  if (configLoading || Date.now() - configCheckedAt < 60000 || !navigator.onLine) return;
  configLoading = true;
  configCheckedAt = Date.now();
  try {
    const res = await fetch('/api/sync-config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.ok) setSyncConfig(await res.json());
  } catch { /* use last known timing until the next refresh */ }
  finally { configLoading = false; }
}

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

// A later edit/poll never postpones an earlier deadline. This bounds sustained writing latency.
function schedule(delay: number) {
  if (typeof window === "undefined") return;
  const due = Math.max(Date.now() + delay, retryAt);
  if (timer && due >= dueAt) return;
  if (timer) clearTimeout(timer);
  dueAt = due;
  timer = setTimeout(() => { timer = null; dueAt = Infinity; void runSync(); }, Math.max(0, due - Date.now()));
}
export function requestSync(delay?: number) {
  if (typeof window === "undefined") return;
  if (delay === undefined) record(editTimes);
  schedule(delay ?? debounceMs);
}
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  const wake = () => { retryAt = 0; configCheckedAt = -Infinity; requestSync(0); };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'visible') wake();
  });
  requestSync(0);
}
async function runSync() {
  if (Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
  if (running) { again = true; return; }
  running = true;
  void refreshConfig();
  try {
    let more = true;
    while (more) more = await syncOnce();
  } catch {
    setStatus('error');
  } finally {
    running = false;
    if (status === 'synced') { failures = 0; retryAt = 0; }
    else {
      failures++;
      retryAt = Date.now() + Math.min(60000, config.retryBaseMs * 2 ** Math.min(failures - 1, 5));
    }
    const pending = again;
    again = false;
    if (pending) schedule(0);
    else if (started) schedule(retryAt ? Math.max(0, retryAt - Date.now()) : document.visibilityState === 'visible' ? config.visiblePollMs : config.hiddenPollMs);
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
    record(requestTimes);
    res = await fetch("/api/sync", {
      signal: AbortSignal.timeout(15000),
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
