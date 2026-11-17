import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILED_AFTER, SYNC_VIEWS, announcedView, describeSync, formatLastSynced, retryCountdown, syncAnnouncement, syncView, type SyncSnapshot } from '@/lib/sync-status';

// Sync badge: mapping the engine's state to what the badge shows and announces, and the engine
// hooks it relies on (backoff in the snapshot, "Retry now").

vi.mock('@/lib/sync-realtime', () => ({ startRealtime: () => () => {} }));
vi.mock('@/lib/db', () => ({
  db: {
    entities: { where: () => ({ equals: () => ({ limit: () => ({ toArray: async () => [] }) }) }), bulkGet: async () => [] },
    events: { where: () => ({ equals: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    meta: { put: async () => {} },
    transaction: async (...args: unknown[]) => (args.at(-1) as () => Promise<void>)(),
  }, getMeta: async () => 0, setMeta: async () => {}, deviceId: () => 'dev',
}));

const NOW = 1_800_000_000_000;
const snap = (s: Partial<SyncSnapshot>): SyncSnapshot => ({ status: 'synced', lastSyncedAt: 0, failures: 0, retryAt: 0, ...s });

describe('state mapping', () => {
  it('maps every engine status to a badge state', () => {
    expect(syncView(snap({ status: 'idle' }))).toBe('starting');
    expect(syncView(snap({ status: 'syncing' }))).toBe('syncing');
    expect(syncView(snap({ status: 'synced' }))).toBe('synced');
    expect(syncView(snap({ status: 'offline' }))).toBe('offline');
    expect(syncView(snap({ status: 'needs-login' }))).toBe('signed-out');
    expect(syncView(snap({ status: 'local-only' }))).toBe('local-only');
  });

  it('shows errors as retrying until they repeat, then as failed', () => {
    for (let failures = 0; failures < FAILED_AFTER; failures++) expect(syncView(snap({ status: 'error', failures }))).toBe('retrying');
    expect(syncView(snap({ status: 'error', failures: FAILED_AFTER }))).toBe('failed');
    expect(syncView(snap({ status: 'error', failures: 20 }))).toBe('failed');
  });

  it('gives each state an icon, a colour and an explanation', () => {
    for (const v of Object.values(SYNC_VIEWS)) {
      expect(v.label).toBeTruthy();
      expect(v.explain.length).toBeGreaterThan(20);
      expect(v.tone).toMatch(/^text-(slate|brand|emerald|amber|rose)-\d+$/);
    }
    expect(new Set(['synced', 'syncing', 'offline', 'retrying', 'failed', 'signed-out'].map(k => SYNC_VIEWS[k as keyof typeof SYNC_VIEWS].icon)).size).toBe(6);
  });

  it('counts down to the next retry in whole seconds', () => {
    expect(retryCountdown(NOW + 12_000, NOW)).toBe(12);
    expect(retryCountdown(NOW + 11_001, NOW)).toBe(12);
    expect(retryCountdown(NOW + 1, NOW)).toBe(1);
    expect(retryCountdown(NOW, NOW)).toBeNull();
    expect(retryCountdown(0, NOW)).toBeNull();
    const d = describeSync(snap({ status: 'error', failures: 1, retryAt: NOW + 4_500 }), NOW);
    expect(d).toMatchObject({ view: 'retrying', label: 'Retrying in 5 s', countdown: 5, canRetry: false });
    expect(describeSync(snap({ status: 'error', failures: 1, retryAt: NOW - 1 }), NOW).label).toBe('Retrying…');
  });

  it('offers Retry now only when failed, with the countdown kept for the popover', () => {
    const d = describeSync(snap({ status: 'error', failures: 5, retryAt: NOW + 60_000 }), NOW);
    expect(d).toMatchObject({ view: 'failed', label: 'Sync failed', countdown: 60, canRetry: true });
    // Offline also backs off, but the badge just says offline.
    expect(describeSync(snap({ status: 'offline', failures: 2, retryAt: NOW + 8_000 }), NOW)).toMatchObject({ label: 'Offline', countdown: null, canRetry: false });
  });

  it('formats the last successful sync', () => {
    expect(formatLastSynced(0, NOW)).toBe('Not synced yet on this device');
    expect(formatLastSynced(NOW - 3_000, NOW)).toBe('Last synced just now');
    expect(formatLastSynced(NOW + 5_000, NOW)).toBe('Last synced just now');
    expect(formatLastSynced(NOW - 42_000, NOW)).toBe('Last synced 42 s ago');
    expect(formatLastSynced(NOW - 5 * 60_000, NOW)).toBe('Last synced 5 min ago');
    expect(formatLastSynced(NOW - 3 * 3_600_000, NOW)).toBe('Last synced 3 h ago');
    expect(formatLastSynced(NOW - 3 * 86_400_000, NOW)).toMatch(/^Last synced \S/);
    expect(describeSync(snap({ lastSyncedAt: NOW - 120_000 }), NOW).lastSynced).toBe('Last synced 2 min ago');
  });
});

describe('live region', () => {
  it('stays silent through syncing and starting, and speaks on real changes', () => {
    let a = announcedView(null, 'starting');
    expect(a).toBeNull();
    a = announcedView(a, 'synced');
    expect(a).toBe('synced');
    for (const v of ['syncing', 'synced', 'syncing', 'synced'] as const) a = announcedView(a, v);
    expect(a).toBe('synced');
    a = announcedView(a, 'offline');
    expect(a).toBe('offline');
    a = announcedView(announcedView(a, 'syncing'), 'retrying');
    expect(a).toBe('retrying');
    expect(syncAnnouncement('signed-out')).toBe('Sync status: Signed out');
    // The countdown is not part of the announcement, so it is not re-read every second.
    expect(syncAnnouncement('retrying')).toBe('Sync status: Retrying');
  });
});

describe('engine hooks', () => {
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

  it('publishes the backoff to subscribers and Retry now skips it without changing the schedule', async () => {
    sync.setSyncConfig({ retryBaseMs: 2000 });
    fetchMock.mockImplementation(async (url: string) => url === '/api/sync-config' ? Response.json({ retryBaseMs: 2000 }) : new Response('', { status: 500 }));
    const seen: ReturnType<typeof sync.getSyncState>[] = [];
    sync.subscribeSync(() => seen.push(sync.getSyncState()));
    sync.startSync(); await vi.advanceTimersByTimeAsync(0);
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ status: 'error', failures: 1 });
    expect(last.retryAt - last.at).toBe(2000);
    expect(describeSync(last, last.at).label).toBe('Retrying in 2 s');

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const failed = seen.at(-1)!;
    expect(describeSync(failed, failed.at)).toMatchObject({ view: 'failed', countdown: 8, canRetry: true });
    const calls = () => fetchMock.mock.calls.filter(c => c[0] === '/api/sync').length;
    expect(calls()).toBe(3);

    fetchMock.mockImplementation(async (url: string) => url === '/api/sync-config' ? Response.json({}) : Response.json({ changes: [], cursor: 1, more: false }));
    sync.retrySyncNow(); await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(4);
    expect(sync.getSyncState()).toMatchObject({ status: 'synced', failures: 0, retryAt: 0 });
    expect(sync.getSyncState().lastSyncedAt).toBe(Date.now());
  });
});
