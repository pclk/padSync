// Opt-in, bounded, in-memory diagnostics. Never retain notebook data, tokens or raw errors.
export type DebugValue = string | number | boolean | null;
export type SyncDebugEvent = { id: number; at: number; kind: string; message: string; details: Record<string, DebugValue> };
export type SyncDebugRequest = {
  id: number; at: number; trigger: string; visibility: string; phase: string;
  queueMs: number; timerLateMs: number; readMs?: number; encodeMs?: number;
  httpMs?: number; decodeMs?: number; applyMs?: number; applyToPaintMs?: number; totalMs?: number;
  status?: number; serverRegion?: string; serverBuild?: string; pushed?: number; events?: number; pulled?: number; applied?: number;
  since?: number; cursor?: number; more?: boolean; server?: Record<string, number>;
  remoteAgeMs?: number; versions?: string[];
  protocol?: string; newConnection?: boolean; connectMs?: number; ttfbMs?: number; downloadMs?: number;
};
const MAX_EVENTS = 150, MAX_REQUESTS = 40;
let enabled = false, sequence = 0;
let events: SyncDebugEvent[] = [];
let requests: SyncDebugRequest[] = [];
const pendingPaint = new Map<string, { appliedAt: number; requestId: number }>();
export const debugNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
export const syncDebugEnabled = () => enabled;
export function clearSyncDebug() { events = []; requests = []; pendingPaint.clear(); }
export function setSyncDebugEnabled(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  clearSyncDebug();
  if (enabled) recordSyncDebug('debug', 'Recording started');
}
export function recordSyncDebug(kind: string, message: string, details: Record<string, DebugValue> = {}) {
  if (!enabled) return;
  events.push({ id: ++sequence, at: Date.now(), kind, message, details });
  if (events.length > MAX_EVENTS) events.shift();
}
export function beginSyncDebugRequest(trigger: string, queueMs = 0, timerLateMs = 0) {
  if (!enabled) return undefined;
  const request: SyncDebugRequest = {
    id: ++sequence, at: Date.now(), trigger, queueMs, timerLateMs, phase: 'Read local queue',
    visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
  };
  requests.push(request);
  if (requests.length > MAX_REQUESTS) requests.shift();
  return request;
}
export function updateSyncDebugRequest(request: SyncDebugRequest | undefined, patch: Partial<SyncDebugRequest>) {
  if (enabled && request && requests.includes(request)) Object.assign(request, patch);
}
export function getSyncDebugSnapshot() {
  return { enabled, events: events.map(event => ({ ...event, details: { ...event.details } })), requests: requests.map(request => ({ ...request, versions: request.versions?.slice(), server: request.server && { ...request.server } })) };
}
export function parseServerTiming(header: string | null): Record<string, number> {
  const result: Record<string, number> = {};
  for (const metric of header?.split(',') ?? []) {
    const match = /^\s*([a-z_]+)\s*;\s*dur=([\d.]+)/i.exec(metric);
    if (match && Number.isFinite(Number(match[2]))) result[match[1]] = Number(match[2]);
  }
  return result;
}
/** Match the same entity version on the sender, receiver and canvas using only metadata. */
export function recordRemoteApplied(request: SyncDebugRequest | undefined, entities: readonly { id: string; hlc: string; kind: string }[]) {
  if (!enabled || !request) return;
  const now = debugNow();
  for (const entity of entities) {
    if (entity.kind === 'stroke') pendingPaint.set(`${entity.id}@${entity.hlc}`, { appliedAt: now, requestId: request.id });
  }
  while (pendingPaint.size > 500) pendingPaint.delete(pendingPaint.keys().next().value!);
  // Presence can be newer than the ink of interest, so age and version samples prefer content.
  const content = entities.filter(entity => entity.kind !== 'presence');
  const sample = content.length ? content : entities;
  const walls = sample.map(entity => /^\d{13}-\d{4}-.+$/.test(entity.hlc) ? Number(entity.hlc.slice(0, 13)) : NaN).filter(Number.isFinite);
  updateSyncDebugRequest(request, {
    versions: sample.slice(0, 8).map(entity => `${entity.kind}:${entity.id}@${entity.hlc}`),
    remoteAgeMs: walls.length ? Date.now() - Math.max(...walls) : undefined,
  });
}
export function recordSyncPaint(entities: readonly { id: string; hlc: string }[], paintMs: number) {
  if (!enabled) return;
  let matched = 0, longest = 0;
  const requestLags = new Map<number, number>();
  for (const entity of entities) {
    const key = `${entity.id}@${entity.hlc}`, entry = pendingPaint.get(key);
    if (!entry) continue;
    matched++; longest = Math.max(longest, debugNow() - entry.appliedAt);
    requestLags.set(entry.requestId, Math.max(requestLags.get(entry.requestId) ?? 0, debugNow() - entry.appliedAt)); pendingPaint.delete(key);
  }
  for (const [id, lag] of requestLags) {
    const request = requests.find(candidate => candidate.id === id);
    if (request) updateSyncDebugRequest(request, { applyToPaintMs: Math.max(request.applyToPaintMs ?? 0, lag) });
  }
  recordSyncDebug('paint', 'Ink canvas painted', { paintMs, receivedVersions: matched, applyToPaintMs: matched ? longest : null, requests: [...requestLags.keys()].join(', ') });
}
/** Splits the HTTP time using the browser's Resource Timing entry for this request: whether it
 * opened a new connection (DNS + TCP + TLS), request sent → first byte, and body download. */
export function recordNetworkTiming(request: SyncDebugRequest | undefined, fetchStart: number) {
  if (!enabled || !request || typeof performance === 'undefined' || !performance.getEntriesByType) return;
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const entry = entries.find(e => e.startTime >= fetchStart - 1 && new URL(e.name, 'http://x').pathname === '/api/sync');
  // The buffer holds 250 entries by default; keep room for the next requests while recording.
  if (entries.length > 200) performance.clearResourceTimings();
  if (!entry || !entry.responseStart) return;
  const connectStart = entry.domainLookupStart || entry.connectStart;
  const newConnection = entry.connectEnd > entry.connectStart || entry.domainLookupEnd > entry.domainLookupStart;
  updateSyncDebugRequest(request, {
    protocol: entry.nextHopProtocol || undefined,
    newConnection,
    connectMs: newConnection ? entry.connectEnd - connectStart : 0,
    ttfbMs: entry.responseStart - (entry.requestStart || entry.startTime),
    downloadMs: entry.responseEnd - entry.responseStart,
  });
}
