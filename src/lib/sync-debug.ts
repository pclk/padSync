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
  /** Request body size, and the response body size the browser reports (compressed, when known). */
  uploadBytes?: number; downloadBytes?: number;
};
const MAX_EVENTS = 150, MAX_REQUESTS = 40;
/** Requests that sent or received edits are kept separately, so the averages cover this many. */
export const MAX_EDITS = 300;
let enabled = false, sequence = 0;
let events: SyncDebugEvent[] = [];
let requests: SyncDebugRequest[] = [];
// Main-thread stalls and input oddities, kept apart so sync chatter never pushes them out.
const MAX_ANOMALIES = 40;
let anomalies: SyncDebugEvent[] = [];
// Raw input as it arrived (downs, ups, cancels, focus, text input), to see what took the Pencil.
const MAX_TRAIL = 80;
let trail: { at: number; text: string }[] = [];
const pendingPaint = new Map<string, { appliedAt: number; requestId: number }>();
// Summaries for the stats report: counters, value statistics, errors and a resource timeline.
// Probes are registered by modules (editor, ink tiles, PDF cache) and read when a report is made.
export type DebugStat = { n: number; sum: number; max: number; min: number; last: number };
const counters = new Map<string, number>();
const stats = new Map<string, DebugStat>();
const probes = new Map<string, () => Record<string, DebugValue>>();
const MAX_ERRORS = 20, MAX_TIMELINE = 120;
let errors: { at: number; kind: string; message: string }[] = [];
let timeline: { at: number; values: Record<string, DebugValue> }[] = [];
let recordingSince = Date.now();
export const debugNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
export const syncDebugEnabled = () => enabled;
export function clearSyncDebug() {
  events = []; requests = []; anomalies = []; trail = []; errors = []; timeline = [];
  counters.clear(); stats.clear(); pendingPaint.clear(); recordingSince = Date.now();
}
export function countDebug(name: string, n = 1) {
  if (enabled) counters.set(name, (counters.get(name) ?? 0) + n);
}
export function observeDebug(name: string, value: number) {
  if (!enabled || !Number.isFinite(value)) return;
  const s = stats.get(name);
  if (s) { s.n++; s.sum += value; s.max = Math.max(s.max, value); s.min = Math.min(s.min, value); s.last = value; }
  else stats.set(name, { n: 1, sum: value, max: value, min: value, last: value });
}
/** Registers live values read into every report; returns the unregister function. */
export function registerDebugProbe(name: string, read: () => Record<string, DebugValue>) {
  probes.set(name, read);
  return () => { if (probes.get(name) === read) probes.delete(name); };
}
export function readDebugProbes() {
  const out: Record<string, Record<string, DebugValue>> = {};
  for (const [name, read] of probes) {
    try { out[name] = read(); } catch (error) { out[name] = { error: error instanceof Error ? error.name : 'failed' }; }
  }
  return out;
}
/** Error text is trimmed; it names code paths, not notebook content. */
export function recordDebugError(kind: string, message: string) {
  if (!enabled) return;
  countDebug(`Errors · ${kind}`);
  errors.push({ at: Date.now(), kind, message: message.slice(0, 200) });
  if (errors.length > MAX_ERRORS) errors.shift();
}
export function recordDebugSample(values: Record<string, DebugValue>) {
  if (!enabled) return;
  timeline.push({ at: Date.now(), values });
  if (timeline.length > MAX_TIMELINE) timeline.shift();
}
export function getDebugSummaries() {
  return {
    since: recordingSince, counters: new Map(counters), stats: new Map([...stats].map(([k, v]) => [k, { ...v }])),
    errors: errors.map(e => ({ ...e })), timeline: timeline.map(t => ({ at: t.at, values: { ...t.values } })),
  };
}
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
export function recordInputAnomaly(message: string, details: Record<string, DebugValue> = {}) {
  if (!enabled) return;
  anomalies.push({ id: ++sequence, at: Date.now(), kind: 'input', message, details });
  if (anomalies.length > MAX_ANOMALIES) anomalies.shift();
  recordSyncDebug('input', message, details);
}
export function recordInputTrail(text: string) {
  if (!enabled) return;
  trail.push({ at: Date.now(), text });
  if (trail.length > MAX_TRAIL) trail.shift();
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
  return { enabled, events: events.map(event => ({ ...event, details: { ...event.details } })), anomalies: anomalies.map(event => ({ ...event, details: { ...event.details } })), trail: trail.map(entry => ({ ...entry })), requests: requests.map(request => ({ ...request, versions: request.versions?.slice(), server: request.server && { ...request.server } })) };
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
  observeDebug('Ink tile paint ms', paintMs);
  observeDebug('Strokes per tile paint', entities.length);
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
    downloadBytes: entry.encodedBodySize || entry.transferSize || undefined,
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
export const clock = (at: number) => new Date(at).toISOString().slice(11, 23);
const details = (e: SyncDebugEvent) => Object.entries(e.details).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(' ');
/** Request outcomes over everything kept: what triggered them, how they ended and the bytes moved. */
export function syncDebugTotals(list = requests) {
  const done = list.filter(r => r.totalMs !== undefined);
  const by = (key: (r: SyncDebugRequest) => string) => {
    const m = new Map<string, number>();
    for (const r of done) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const sum = (key: 'uploadBytes' | 'downloadBytes') => done.reduce((a, r) => a + (r[key] ?? 0), 0);
  return { count: done.length, triggers: by(r => r.trigger), outcomes: by(r => `${r.phase}${r.status ? ` ${r.status}` : ''}`), uploadBytes: sum('uploadBytes'), downloadBytes: sum('downloadBytes'), pulled: done.reduce((a, r) => a + (r.pulled ?? 0), 0), pushed: done.reduce((a, r) => a + (r.pushed ?? 0), 0) };
}

export const kb = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;

/** The sync part of the summary: averages of the last 300 edit requests, totals and anomaly counts. */
export function formatSyncSummary(header: string[], now = Date.now()) {
  const stats = syncDebugStats();
  const edits = requests.filter(isEdit);
  const since = edits.length ? ` since ${clock(edits[0].at)}` : '';
  const lines = [`padSync sync stats · ${new Date(now).toISOString()} · last ${edits.length} of up to ${MAX_EDITS} edit requests${since}`, ...header, ''];
  lines.push(`ms (avg / max)`.padEnd(26) + stats.map(g => `${g.label} n=${g.count}`.padEnd(24)).join(''));
  for (const [key, label] of STAT_METRICS) lines.push(label.padEnd(26) + stats.map(g => `${f(g.avg[key])} / ${f(g.max[key])}`.padEnd(24)).join(''));
  lines.push('New connections'.padEnd(26) + stats.map(g => `${g.newConnections}/${g.count} ${g.protocols.join(',')}`.padEnd(24)).join(''));
  const t = syncDebugTotals();
  lines.push('', `Requests kept: ${t.count} · ↑ ${t.pushed} entities, ${kb(t.uploadBytes)} · ↓ ${t.pulled} entities, ${kb(t.downloadBytes)}${t.count ? ` · avg ↑ ${kb(Math.round(t.uploadBytes / t.count))} ↓ ${kb(Math.round(t.downloadBytes / t.count))}` : ''}`);
  if (t.triggers.length) lines.push(`  Triggers: ${t.triggers.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  if (t.outcomes.length) lines.push(`  Outcomes: ${t.outcomes.map(([k, n]) => `${k} ×${n}`).join(' · ')}`);
  lines.push('', `Input and main-thread stalls: ${anomalies.length ? '' : 'none recorded'}`);
  const kinds = new Map<string, { n: number; max: number }>();
  for (const e of anomalies) {
    const k = kinds.get(e.message) ?? { n: 0, max: 0 };
    k.n++; if (typeof e.details.ms === 'number') k.max = Math.max(k.max, e.details.ms);
    kinds.set(e.message, k);
  }
  for (const [message, k] of kinds) lines.push(`  ${message}: ${k.n}${k.max ? ` · longest ${Math.round(k.max)} ms` : ''}`);
  return lines;
}

/** The individual records: anomalies, raw input, requests and events. */
export function formatSyncTrace() {
  const lines = ['', `Input and main-thread stalls (last ${MAX_ANOMALIES}):`];
  if (!anomalies.length) lines.push('none recorded');
  for (const e of anomalies) lines.push(`${clock(e.at)} ${e.message} · ${details(e)}`);
  lines.push('', `Recent input (last ${MAX_TRAIL}):`);
  if (!trail.length) lines.push('none recorded');
  for (const t of trail) lines.push(`${clock(t.at)} ${t.text}`);
  lines.push('', 'Requests (edits, plus the newest 40 of any kind):');
  for (const r of requests) {
    lines.push(`#${r.id} ${clock(r.at)} ${r.trigger} · ${r.phase} ${r.status ?? ''} · ↑${r.pushedContent ?? 0}/${r.pushed ?? 0} ↓${r.appliedContent ?? 0}/${r.applied ?? 0} · wait ${f(r.queueMs)} http ${f(r.httpMs)} (${r.newConnection ? 'new' : r.newConnection === false ? 'reused' : '?'} conn ${f(r.connectMs)}, ttfb ${f(r.ttfbMs)}, server ${f(r.server?.total)}, dl ${f(r.downloadMs)}) total ${f(r.totalMs)} · ${r.uploadBytes !== undefined ? `${kb(r.uploadBytes)} up` : '? up'} ${r.downloadBytes !== undefined ? `${kb(r.downloadBytes)} down` : '? down'} · sentAge ${f(r.sendAgeMs)} recvAge ${f(r.remoteAgeMs)} paint ${f(r.applyToPaintMs)}`);
  }
  lines.push('', 'Errors and console messages:');
  if (!errors.length) lines.push('none recorded');
  for (const e of errors) lines.push(`${clock(e.at)} ${e.kind} · ${e.message}`);
  lines.push('', 'Events:');
  for (const e of events) {
    const d = details(e);
    lines.push(`${clock(e.at)} ${e.kind} · ${e.message}${d ? ` · ${d}` : ''}`);
  }
  return lines;
}

/** A plain-text report meant to be pasted into a chat: the summary, then the records. No notebook content. */
export function formatSyncDebugReport(header: string[], now = Date.now()) {
  return [...formatSyncSummary(header, now), ...formatSyncTrace()].join('\n');
}
