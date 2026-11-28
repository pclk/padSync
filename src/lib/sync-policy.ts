// Each send also wakes every other open device to fetch, so one per stroke multiplied the requests.
export const DEFAULT_DEBOUNCE_MS = 2000;
export const MIN_DEBOUNCE_MS = 0;
export const MAX_DEBOUNCE_MS = 10000;
// Realtime normally wakes sync; this only paces devices whose realtime is down.
export const VISIBLE_POLL_MS = 5000;
export const HIDDEN_POLL_MS = 60000;
export function validDebounce(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_DEBOUNCE_MS && value <= MAX_DEBOUNCE_MS;
}

export const SYNC_FIELDS = {
  debounceMs: { label: 'Send delay', min: 0, max: 10000, default: DEFAULT_DEBOUNCE_MS, help: 'Wait after the first local edit before sending a batch. Zero sends without an intentional delay.' },
  visiblePollMs: { label: 'Receive interval while visible', min: 0, max: 30000, default: VISIBLE_POLL_MS, help: 'How often each visible device checks for changes from the other device. Lower this to receive edits sooner. Zero checks again as soon as the previous request finishes.' },
  hiddenPollMs: { label: 'Receive interval while hidden', min: 0, max: 120000, default: HIDDEN_POLL_MS, help: 'Checks while the tab is hidden. Zero checks again after each completed request. iPadOS and browsers may throttle or suspend background tabs regardless of this value.' },
  retryBaseMs: { label: 'Initial retry delay', min: 0, max: 30000, default: 2000, help: 'Wait after a failed sync. Zero retries without an intentional delay. For positive values, repeated failures double this delay up to 60 seconds; returning online retries immediately.' },
} as const;
export type SyncConfig = { [K in keyof typeof SYNC_FIELDS]: number };
export const DEFAULT_SYNC_CONFIG: SyncConfig = { debounceMs: DEFAULT_DEBOUNCE_MS, visiblePollMs: VISIBLE_POLL_MS, hiddenPollMs: HIDDEN_POLL_MS, retryBaseMs: 2000 };
export const FAST_SYNC_CONFIG: SyncConfig = { ...DEFAULT_SYNC_CONFIG, debounceMs: 50 };
export function validSyncField(key: keyof SyncConfig, value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= SYNC_FIELDS[key].min && value <= SYNC_FIELDS[key].max;
}
export function normalizeSyncConfig(value: Partial<SyncConfig>): SyncConfig {
  const result = { ...DEFAULT_SYNC_CONFIG };
  for (const key of Object.keys(SYNC_FIELDS) as (keyof SyncConfig)[]) {
    if (validSyncField(key, value[key])) result[key] = value[key]!;
  }
  return result;
}

/** Replay a local edit trace with the actual first-edit coalescing policy. No network latency,
 * pagination, retries or visibility transitions: request counts, not CPU or billing predictions. */
export function replaySyncRequests(edits: readonly number[], start: number, end: number, debounceMs: number, pollMs = VISIBLE_POLL_MS) {
  // With zero polling, request count depends on response time, which this model omits.
  if (pollMs <= 0) return Infinity;
  let due = start + pollMs, requests = 0;
  for (const edit of edits) {
    if (edit < start || edit > end) continue;
    while (due <= edit) { requests++; due += pollMs; }
    due = Math.min(due, edit + debounceMs);
  }
  while (due <= end) { requests++; due += pollMs; }
  return requests;
}
