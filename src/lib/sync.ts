import { beginSyncDebugRequest, debugNow, parseServerTiming, recordRemoteApplied, recordSyncDebug, syncDebugEnabled, updateSyncDebugRequest } from "./sync-debug";
import { startRealtime, type RealtimeStatus } from "./sync-realtime";
import { DEFAULT_DEBOUNCE_MS, validDebounce, DEFAULT_SYNC_CONFIG, normalizeSyncConfig, type SyncConfig } from "./sync-policy";
import { db, getMeta, setMeta } from "./db";
import { hlcObserve } from "./hlc";
import type { Entity } from "./types";

// Offline-first sync. Local writes land in IndexedDB marked dirty; this engine pushes them
// (debounced) and pulls everything the server has seen since our cursor. The same POST does
// both, so one round trip per tick. Realtime metadata notifications wake this same
// engine, with HTTP polling retained for recovery.

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "local-only" | "needs-login" | "error";

let realtimeStatus: RealtimeStatus = 'connecting';
let stopRealtime: (() => void) | undefined;
let stopWakeListeners: (() => void) | undefined;
const REALTIME_RECOVERY_MS = 30000;
function pollDelay() {
  const configured = typeof document === 'undefined' || document.visibilityState === 'visible' ? config.visiblePollMs : config.hiddenPollMs;
  return realtimeStatus === 'live' ? Math.max(REALTIME_RECOVERY_MS, configured) : configured;
}
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
let generation = 0;
let again = false;
let started = false;
let dueAt = Infinity;
let scheduledReason = "none";
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
  return { ...config, debounceMs, realtimeStatus, effectivePollMs: pollDelay(), start, end: now, edits: editTimes.filter(t => t >= start), requests: requestTimes.filter(t => t >= start).length, traceTruncated, status, running, again, failures, retryAt, nextDueAt: Number.isFinite(dueAt) ? dueAt : null, scheduledReason, configCheckedAt: Number.isFinite(configCheckedAt) ? configCheckedAt : null };
}
export function setSyncDebounce(value: number) {
  if (validDebounce(value)) setSyncConfig({ ...config, debounceMs: value });
}
export function setSyncConfig(value: Partial<SyncConfig>) {
  config = normalizeSyncConfig({ ...config, ...value });
  debounceMs = config.debounceMs;
  // A faster configuration advances an existing poll without delaying queued writes.
  if (started) schedule(pollDelay());
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
function schedule(delay: number, reason = "poll") {
  if (typeof window === "undefined") return;
  const due = Math.max(Date.now() + delay, retryAt);
  if (timer && due >= dueAt) {
    recordSyncDebug('schedule', 'Joined earlier deadline', { trigger: reason, earlierTrigger: scheduledReason, dueInMs: Math.max(0, dueAt - Date.now()) });
    return;
  }
  if (timer) clearTimeout(timer);
  dueAt = due; scheduledReason = reason;
  const queuedAt = debugNow();
  recordSyncDebug('schedule', 'Sync scheduled', { trigger: reason, delayMs: delay, dueInMs: Math.max(0, due - Date.now()), visibility: document.visibilityState });
  timer = setTimeout(() => {
    const context = { trigger: reason, queueMs: debugNow() - queuedAt, timerLateMs: Math.max(0, Date.now() - due) };
    timer = null; dueAt = Infinity; void runSync(context);
  }, Math.max(0, due - Date.now()));
}
export function requestSync(delay?: number, reason = delay === undefined ? "local edit" : "manual") {
  if (typeof window === "undefined") return;
  if (delay === undefined) record(editTimes);
  recordSyncDebug("trigger", "Sync requested", { trigger: reason, delayMs: delay ?? debounceMs });
  schedule(delay ?? debounceMs, reason);
}
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  stopRealtime = startRealtime(() => requestSync(0, "realtime notification"), next => {
    const wasLive = realtimeStatus === 'live';
    realtimeStatus = next;
    recordSyncDebug("realtime", "Realtime state", { state: next, visibility: document.visibilityState });
    if (wasLive && next !== 'live') schedule(pollDelay());
    listeners.forEach(listener => listener());
  });
  const wake = () => { retryAt = 0; configCheckedAt = -Infinity; requestSync(0, "online / visible wake"); };
  const stateChanged = () => recordSyncDebug('browser', 'Browser state changed', { visibility: document.visibilityState, online: navigator.onLine, focused: document.hasFocus?.() ?? false });
  document.addEventListener('visibilitychange', stateChanged);
  window.addEventListener('focus', stateChanged);
  window.addEventListener('blur', stateChanged);
  window.addEventListener('offline', stateChanged);
  window.addEventListener("online", wake);
  const visible = () => { if (document.visibilityState === 'visible') wake(); };
  document.addEventListener("visibilitychange", visible);
  stopWakeListeners = () => {
    window.removeEventListener("online", wake);
    document.removeEventListener('visibilitychange', stateChanged);
    window.removeEventListener('focus', stateChanged);
    window.removeEventListener('blur', stateChanged);
    window.removeEventListener('offline', stateChanged);
    document.removeEventListener("visibilitychange", visible);
  };
  requestSync(0);
}
async function runSync(context = { trigger: "manual", queueMs: 0, timerLateMs: 0 }) {
  if (Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
  if (running) { again = true; recordSyncDebug("schedule", "Waiting for in-flight request", { trigger: context.trigger }); return; }
  running = true;
  const current = generation;
  void refreshConfig();
  try {
    let more = true;
    while (more && current === generation) {
      more = await syncOnce(context);
      context = { trigger: "pagination / backlog", queueMs: 0, timerLateMs: 0 };
    }
  } catch {
    setStatus('error');
  } finally {
    running = false;
    if (status === 'synced') { failures = 0; retryAt = 0; }
    else {
      failures++;
      retryAt = Date.now() + Math.min(60000, config.retryBaseMs * 2 ** Math.min(failures - 1, 16));
    }
    const pending = again;
    again = false;
    if (current !== generation) {
      // A stopped run may finish its acknowledgement, but must not continue draining.
      if (started) schedule(0, "restart");
    } else if (pending) schedule(0, "follow-up");
    else if (started) schedule(retryAt ? Math.max(0, retryAt - Date.now()) : pollDelay(), retryAt ? "retry" : document.visibilityState === "visible" ? "visible poll" : "hidden poll");
  }
}

/** One push+pull round trip; true when there is more to do. Exported for tests. */
export async function syncOnce(context = { trigger: "manual", queueMs: 0, timerLateMs: 0 }): Promise<boolean> {
  const trace = beginSyncDebugRequest(context.trigger, context.queueMs, context.timerLateMs);
  const began = debugNow();
  let phaseStart = began;
  let completed = false;
  try {
    if (!navigator.onLine) {
      setStatus("offline");
      return false;
    }
    const [dirty, events, since] = await Promise.all([
      db.entities.where("dirty").equals(1).limit(ENTITY_BATCH).toArray(),
      db.events.where("synced").equals(0).limit(EVENT_BATCH).toArray(),
      getMeta<number>("cursor").then((c) => c ?? 0),
    ]);
    updateSyncDebugRequest(trace, { readMs: debugNow() - phaseStart, pushed: dirty.length, events: events.length, since, phase: 'Encode request' });
    if (status !== "synced" || dirty.length || events.length) setStatus("syncing");
    phaseStart = debugNow();
    const payload = JSON.stringify({
      since, changes: dirty.map(e => ({ ...e, dirty: undefined })),
      events: events.map(e => ({ ...e, synced: undefined })),
    });
    updateSyncDebugRequest(trace, { encodeMs: debugNow() - phaseStart, phase: 'HTTP round trip' });

    let res: Response;
    try {
      record(requestTimes);
      phaseStart = debugNow();
      res = await fetch("/api/sync", {
        signal: AbortSignal.timeout(15000),
        method: "POST",
        headers: { "content-type": "application/json", ...(trace ? { "x-padsync-debug": "1" } : {}) },
        body: payload,
      });
    } catch {
      updateSyncDebugRequest(trace, { httpMs: debugNow() - phaseStart, phase: 'Network failure / timeout' });
      setStatus("offline");
      return false;
    }
    updateSyncDebugRequest(trace, { httpMs: debugNow() - phaseStart, status: res.status, server: parseServerTiming(res.headers.get('Server-Timing')), serverRegion: res.headers.get('X-PadSync-Server-Region') ?? undefined, serverBuild: res.headers.get('X-PadSync-Server-Build') ?? undefined, phase: 'Read response body + JSON' });
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

    phaseStart = debugNow();
    const body = (await res.json()) as { changes: Omit<Entity, "dirty">[]; cursor: number; more: boolean };

    updateSyncDebugRequest(trace, { decodeMs: debugNow() - phaseStart, pulled: body.changes.length, cursor: body.cursor, more: body.more, phase: 'Apply to IndexedDB' });
    phaseStart = debugNow();
    let applied: typeof body.changes = [];
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
        applied = newer;
        if (newer.length) await db.entities.bulkPut(newer.map((r) => ({ ...r, dirty: 0 as const })));
      }
      await db.meta.put({ key: "cursor", value: body.cursor });
    });

    updateSyncDebugRequest(trace, { applyMs: debugNow() - phaseStart, applied: applied.length, phase: 'Done' });
    recordRemoteApplied(trace, applied);
    completed = true;
    setStatus("synced");
    return body.more || dirty.length === ENTITY_BATCH || events.length === EVENT_BATCH;
  } catch (error) {
    updateSyncDebugRequest(trace, { phase: `Error during ${trace?.phase ?? 'sync'} (${error instanceof Error ? error.name : 'unknown'})` });
    throw error;
  } finally {
    updateSyncDebugRequest(trace, { totalMs: debugNow() - began, ...(!completed && !trace?.phase.startsWith("Error") ? { phase: `${trace?.phase ?? "Failed"} · ${status}` } : {}) });
    if (trace && syncDebugEnabled()) recordSyncDebug('request', completed ? 'Sync completed' : 'Sync failed', { request: trace.id, trigger: trace.trigger, status, durationMs: debugNow() - began });
  }
}

export function stopSync() {
  generation++;
  started = false; again = false;
  stopWakeListeners?.(); stopWakeListeners = undefined;
  stopRealtime?.(); stopRealtime = undefined;
  realtimeStatus = 'suspended';
  if (timer) clearTimeout(timer);
  timer = null; dueAt = Infinity;
}

export async function resetCursor() {
  await setMeta("cursor", 0);
  requestSync(0);
}
