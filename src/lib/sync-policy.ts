export const DEFAULT_DEBOUNCE_MS = 400;
export const MIN_DEBOUNCE_MS = 100;
export const MAX_DEBOUNCE_MS = 10000;
export const VISIBLE_POLL_MS = 2000;
export const HIDDEN_POLL_MS = 15000;
export function validDebounce(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_DEBOUNCE_MS && value <= MAX_DEBOUNCE_MS;
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
