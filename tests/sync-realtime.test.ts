import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startRealtime } from '@/lib/sync-realtime';
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@neon/realtime/client', () => ({ createRealtimeClient: sdk.create }));
let change: (snapshot: { status: string; data?: { id: string; seq: string }[] }) => void;
let fetchMock: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let renew: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;
const enabled = () => ({ enabled: true, login: 'pclk', url: 'wss://example.test', query: { capability: 'opaque', queryFingerprint: 'same', expiresAt: Date.now() + 60000 } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  fetchMock = vi.fn(async () => Response.json(enabled())); vi.stubGlobal('fetch', fetchMock);
  close = vi.fn(); renew = vi.fn(async () => {});
  sdk.create.mockReset().mockImplementation(() => ({ close, subscribe: () => ({ renew, onChange: (fn: typeof change) => { change = fn; } }) }));
});
afterEach(() => { stop?.(); stop = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function flush() { await vi.advanceTimersByTimeAsync(0); }
it('reconciles initial/live changes and reconnect without duplicating lifecycle snapshots', async () => {
  const notify = vi.fn(), state = vi.fn(); stop = startRealtime(notify, state); await flush();
  change({ status: 'live', data: [] }); change({ status: 'live', data: [] });
  expect(notify).toHaveBeenCalledTimes(1);
  change({ status: 'live', data: [{ id: 'a', seq: '1' }] });
  expect(notify).toHaveBeenCalledTimes(2);
  change({ status: 'stale', data: [{ id: 'a', seq: '1' }] });
  change({ status: 'live', data: [{ id: 'a', seq: '1' }] });
  expect(notify).toHaveBeenCalledTimes(3);
  expect(state).toHaveBeenLastCalledWith('live');
});
it('renews the sealed query before expiry through the authenticated endpoint', async () => {
  stop = startRealtime(vi.fn(), vi.fn()); await flush();
  await vi.advanceTimersByTimeAsync(50000);
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(renew).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('/api/sync/live', expect.objectContaining({ method: 'POST', cache: 'no-store' }));
});
it('closes on failed renewal and retries with a fresh client', async () => {
  const state = vi.fn(); stop = startRealtime(vi.fn(), state); await flush();
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
  await vi.advanceTimersByTimeAsync(50000);
  expect(close).toHaveBeenCalledTimes(1); expect(state).toHaveBeenLastCalledWith('fallback');
  await vi.advanceTimersByTimeAsync(2000); expect(sdk.create).toHaveBeenCalledTimes(2);
});
it('recreates terminal subscriptions and ignores old callbacks', async () => {
  const notify = vi.fn(); stop = startRealtime(notify, vi.fn()); await flush();
  const old = change; old({ status: 'error' });
  expect(close).toHaveBeenCalledTimes(1);
  old({ status: 'live', data: [] }); expect(notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000); expect(sdk.create).toHaveBeenCalledTimes(2);
});
it('suspends while hidden/offline and resubscribes on wake', async () => {
  stop = startRealtime(vi.fn(), vi.fn()); await flush();
  Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
  expect(close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000); expect(fetchMock).toHaveBeenCalledTimes(1);
  Object.assign(document, { visibilityState: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); await flush();
  expect(sdk.create).toHaveBeenCalledTimes(2);
});
it('missing configuration preserves polling and checks again later', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ enabled: false }));
  const state = vi.fn(); stop = startRealtime(vi.fn(), state); await flush();
  expect(state).toHaveBeenLastCalledWith('disabled'); expect(sdk.create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000); expect(sdk.create).toHaveBeenCalledTimes(1);
});
it('stopping during authorization prevents a late subscription', async () => {
  let release!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  stop = startRealtime(vi.fn(), vi.fn()); stop();
  release(Response.json(enabled())); await flush(); expect(sdk.create).not.toHaveBeenCalled();
});
it('a different session on renewal tears down the old subscription', async () => {
  stop = startRealtime(vi.fn(), vi.fn()); await flush();
  fetchMock.mockResolvedValueOnce(Response.json({ ...enabled(), login: 'different' }));
  await vi.advanceTimersByTimeAsync(50000); expect(close).toHaveBeenCalledTimes(1); expect(renew).not.toHaveBeenCalled();
});
