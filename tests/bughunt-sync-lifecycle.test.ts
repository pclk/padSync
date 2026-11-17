import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/sync-realtime', () => ({ startRealtime: () => () => {} }));
vi.mock('@/lib/db', () => ({
  db: {
    entities: { where: () => ({ equals: () => ({ limit: () => ({ toArray: async () => [] }) }) }), bulkGet: async () => [] },
    events: { where: () => ({ equals: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    meta: { put: async () => {} },
    transaction: async (...args: unknown[]) => (args.at(-1) as () => Promise<void>)(),
  }, getMeta: async () => 0, setMeta: async () => {},
}));
let sync: typeof import('@/lib/sync');
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  sync = await import('@/lib/sync');
});
afterEach(() => { sync.stopSync(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('stops pagination and queued follow-ups when stopped during a request', async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/sync-config') return Response.json({});
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ changes: [], cursor: 2, more: false });
  });
  sync.startSync(); await vi.advanceTimersByTimeAsync(0);
  sync.requestSync(0); await vi.advanceTimersByTimeAsync(1);
  sync.stopSync();
  release(Response.json({ changes: [], cursor: 1, more: true }));
  await vi.advanceTimersByTimeAsync(60000);
  expect(calls).toBe(1);
  expect(sync.getSyncTiming()).toMatchObject({ running: false, nextDueAt: null });
});
it('continues exponential retry growth past the sixth failure for a small retry base', async () => {
  sync.setSyncConfig({ retryBaseMs: 500 });
  fetchMock.mockImplementation(async (url: string) => url === '/api/sync-config'
    ? Response.json({ retryBaseMs: 500 }) : new Response('', { status: 500 }));
  sync.startSync(); await vi.advanceTimersByTimeAsync(0);
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000]) await vi.advanceTimersByTimeAsync(delay);
  expect(fetchMock.mock.calls.filter(call => call[0] === '/api/sync')).toHaveLength(7);
  expect(sync.getSyncTiming().retryAt - Date.now()).toBe(32000);
  await vi.advanceTimersByTimeAsync(32000);
  expect(sync.getSyncTiming().retryAt - Date.now()).toBe(60000);
  await vi.advanceTimersByTimeAsync(59999);
  expect(fetchMock.mock.calls.filter(call => call[0] === '/api/sync')).toHaveLength(8);
});
it('reconciles after restart without overlapping the previous request', async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/sync-config') return Response.json({});
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ changes: [], cursor: 2, more: false });
  });
  sync.startSync(); await vi.advanceTimersByTimeAsync(0);
  sync.stopSync(); sync.startSync(); await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(1);
  release(Response.json({ changes: [], cursor: 1, more: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  expect(sync.getSyncTiming().running).toBe(false);
});
