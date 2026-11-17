export const DEFAULT_DEBOUNCE_MS = 400;
export const MIN_DEBOUNCE_MS = 100;
export const MAX_DEBOUNCE_MS = 10000;
export const VISIBLE_POLL_MS = 2000;
export const HIDDEN_POLL_MS = 15000;
export function validDebounce(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_DEBOUNCE_MS && value <= MAX_DEBOUNCE_MS;
}

export const SYNC_FIELDS = {
  debounceMs: { label: 'Send delay', min: 100, max: 10000, default: DEFAULT_DEBOUNCE_MS, help: 'Wait after the first local edit before sending a batch.' },
  visiblePollMs: { label: 'Receive interval while visible', min: 100, max: 30000, default: VISIBLE_POLL_MS, help: 'How often each visible device checks for changes from the other device. Lower this to receive edits sooner.' },
  hiddenPollMs: { label: 'Receive interval while hidden', min: 1000, max: 120000, default: HIDDEN_POLL_MS, help: 'Checks while the tab is hidden. iPadOS and browsers may throttle or suspend background tabs regardless of this value.' },
  retryBaseMs: { label: 'Initial retry delay', min: 250, max: 30000, default: 2000, help: 'Wait after a failed sync. Repeated failures double this delay up to 60 seconds; returning online retries immediately.' },
} as const;
export type SyncConfig = { [K in keyof typeof SYNC_FIELDS]: number };
export const DEFAULT_SYNC_CONFIG: SyncConfig = { debounceMs: DEFAULT_DEBOUNCE_MS, visiblePollMs: VISIBLE_POLL_MS, hiddenPollMs: HIDDEN_POLL_MS, retryBaseMs: 2000 };
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
  let due = start + pollMs, requests = 0;
  for (const edit of edits) {
    if (edit < start || edit > end) continue;
    while (due <= edit) { requests++; due += pollMs; }
    due = Math.min(due, edit + debounceMs);
  }
  while (due <= end) { requests++; due += pollMs; }
  return requests;
}
