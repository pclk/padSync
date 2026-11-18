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
  /** Non-presence entities sent / applied, so averages can separate ink from presence and empty polls. */
  pushedContent?: number; appliedContent?: number;
  /** Sender side: how long the oldest edit in this push waited on this device before the server acked it. */
  sendAgeMs?: number;
};
const MAX_EVENTS = 150, MAX_REQUESTS = 40;
/** Requests that sent or received edits are kept separately, so the averages cover this many. */
export const MAX_EDITS = 300;
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
const isEdit = (r: SyncDebugRequest) => (r.pushedContent ?? 0) > 0 || (r.appliedContent ?? 0) > 0;
// The newest 40 requests of any kind stay for the history picker; edit requests stay up to 300,
// so empty polls and presence-only requests never push edits out.
function pruneRequests() {
  let others = 0, edits = 0;
  for (let i = requests.length - 1; i >= 0; i--) {
    if (isEdit(requests[i]) ? ++edits > MAX_EDITS : ++others > MAX_REQUESTS) requests.splice(i, 1);
  }
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
  pruneRequests();
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
    appliedContent: content.length,
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

// --- statistics over the last 300 edits ------------------------------------------------------
type Num = keyof { [K in keyof SyncDebugRequest as SyncDebugRequest[K] extends number | undefined ? K : never]: 1 };
export const STAT_METRICS: [Num | 'serverTotal', string][] = [
  ['queueMs', 'Scheduled wait'], ['timerLateMs', 'Timer late'], ['readMs', 'Read local queue'], ['encodeMs', 'Encode upload'],
  ['httpMs', 'HTTP → headers'], ['connectMs', '  DNS + TCP + TLS'], ['ttfbMs', '  Sent → first byte'], ['serverTotal', '  Server total'],
  ['downloadMs', '  Response download'], ['decodeMs', 'Body + JSON'], ['applyMs', 'Apply to storage'], ['totalMs', 'Request total'],
  ['applyToPaintMs', 'Storage → ink painted'], ['sendAgeMs', 'Sent edit age at ack'], ['remoteAgeMs', 'Received edit age'],
];
export type StatGroup = { label: string; count: number; newConnections: number; protocols: string[]; avg: Record<string, number | undefined>; max: Record<string, number | undefined> };
const metric = (r: SyncDebugRequest, key: Num | 'serverTotal') => key === 'serverTotal' ? r.server?.total : r[key];

/** Averages over the kept edit requests: received from the other device, sent from this one, and both. */
export function syncDebugStats(list = requests) {
  const recent = list.filter(r => r.totalMs !== undefined && isEdit(r));
  const group = (label: string, rows: SyncDebugRequest[]): StatGroup => {
    const avg: StatGroup['avg'] = {}, max: StatGroup['max'] = {};
    for (const [key] of STAT_METRICS) {
      const values = rows.map(r => metric(r, key)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      avg[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
      max[key] = values.length ? Math.max(...values) : undefined;
    }
    return { label, count: rows.length, newConnections: rows.filter(r => r.newConnection).length, protocols: [...new Set(rows.map(r => r.protocol).filter((p): p is string => !!p))], avg, max };
  };
  return [
    group('Received edits', recent.filter(r => (r.appliedContent ?? 0) > 0)),
    group('Sent edits', recent.filter(r => (r.pushedContent ?? 0) > 0)),
    group('All edits', recent),
  ];
}

const f = (v?: number) => v === undefined ? '—' : `${Math.round(v)}`;
const clock = (at: number) => new Date(at).toISOString().slice(11, 23);
/** A plain-text report of the last 300 edit requests, meant to be pasted into a chat. No notebook content. */
export function formatSyncDebugReport(header: string[], now = Date.now()) {
  const stats = syncDebugStats();
  const edits = requests.filter(isEdit);
  const since = edits.length ? ` since ${clock(edits[0].at)}` : '';
  const lines = [`padSync sync stats · ${new Date(now).toISOString()} · last ${edits.length} of up to ${MAX_EDITS} edit requests${since}`, ...header, ''];
  lines.push(`ms (avg / max)`.padEnd(26) + stats.map(g => `${g.label} n=${g.count}`.padEnd(24)).join(''));
  for (const [key, label] of STAT_METRICS) lines.push(label.padEnd(26) + stats.map(g => `${f(g.avg[key])} / ${f(g.max[key])}`.padEnd(24)).join(''));
  lines.push('New connections'.padEnd(26) + stats.map(g => `${g.newConnections}/${g.count} ${g.protocols.join(',')}`.padEnd(24)).join(''));
  lines.push('', 'Requests (edits, plus the newest 40 of any kind):');
  for (const r of requests) {
    lines.push(`#${r.id} ${clock(r.at)} ${r.trigger} · ${r.phase} ${r.status ?? ''} · ↑${r.pushedContent ?? 0}/${r.pushed ?? 0} ↓${r.appliedContent ?? 0}/${r.applied ?? 0} · wait ${f(r.queueMs)} http ${f(r.httpMs)} (${r.newConnection ? 'new' : r.newConnection === false ? 'reused' : '?'} conn ${f(r.connectMs)}, ttfb ${f(r.ttfbMs)}, server ${f(r.server?.total)}, dl ${f(r.downloadMs)}) total ${f(r.totalMs)} · sentAge ${f(r.sendAgeMs)} recvAge ${f(r.remoteAgeMs)} paint ${f(r.applyToPaintMs)}`);
  }
  lines.push('', 'Events:');
  for (const e of events) {
    const details = Object.entries(e.details).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(' ');
    lines.push(`${clock(e.at)} ${e.kind} · ${e.message}${details ? ` · ${details}` : ''}`);
  }
  return lines.join('\n');
}
