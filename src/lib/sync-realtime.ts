import { createRealtimeClient, type MaterializedLiveQuerySubscription, type RealtimeClient, type SealedLiveQuery } from '@neon/realtime/client';

export type RealtimeStatus = 'connecting' | 'live' | 'fallback' | 'disabled' | 'suspended';
type Hint = { id: string; seq: string };
type Capability = { enabled: true; url: string; login: string; query: SealedLiveQuery<Hint> } | { enabled: false };

/** Notifications only wake HTTP reconciliation. Never use their sequence as the HTTP cursor. */
export function startRealtime(onNotify: () => void, onStatus: (status: RealtimeStatus) => void) {
  let stopped = false;
  let generation = 0;
  let client: RealtimeClient | undefined;
  let subscription: MaterializedLiveQuerySubscription<Hint> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let login: string | undefined;
  let failures = 0;
  let status: RealtimeStatus = 'connecting';
  const publish = (next: RealtimeStatus) => { status = next; onStatus(next); };
  const active = () => !stopped && navigator.onLine && document.visibilityState === 'visible';
  function clear() {
    generation++;
    clearTimeout(timer);
    request?.abort(); request = undefined;
    const old = client;
    client = undefined; subscription = undefined;
    old?.close();
  }
  function later(fn: () => void, delay: number) {
    clearTimeout(timer);
    if (active()) timer = setTimeout(fn, delay);
  }
  function failed() {
    if (stopped) return;
    clear(); publish('fallback');
    later(() => { void connect(); }, Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)));
  }
  async function capability(): Promise<Capability> {
    request = new AbortController();
    const response = await fetch('/api/sync/live', {
      method: 'POST', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error('Realtime authorization unavailable');
    return response.json();
  }
  function renewAt(expiresAt: number) {
    later(() => { void renew(); }, Math.max(1000, expiresAt - Date.now() - 10000));
  }
  async function renew() {
    const current = generation;
    try {
      const next = await capability();
      if (current !== generation || !active()) return;
      if (!next.enabled || next.login !== login) { failed(); return; }
      await subscription!.renew(next.query);
      if (current === generation) renewAt(next.query.expiresAt);
    } catch { if (current === generation) failed(); }
  }
  async function connect() {
    clear();
    if (!active()) { publish('suspended'); return; }
    publish('connecting');
    const current = generation;
    try {
      const next = await capability();
      if (current !== generation || !active()) return;
      if (!next.enabled) {
        publish('disabled'); later(() => { void connect(); }, 60000); return;
      }
      // A new login must never reuse the old connection or subscription.
      login = next.login;
      client = createRealtimeClient({ url: next.url });
      subscription = client.subscribe(next.query);
      let signature: string | undefined;
      subscription.onChange(snapshot => {
        if (current !== generation || !active()) return;
        if (snapshot.status === 'error' || snapshot.status === 'closed') { failed(); return; }
        if (snapshot.status !== 'live') { publish('connecting'); return; }
        const wasLive = status === 'live';
        publish('live'); failures = 0;
        const nextSignature = JSON.stringify(snapshot.data);
        if (!wasLive || signature !== nextSignature) { signature = nextSignature; onNotify(); }
      });
      renewAt(next.query.expiresAt);
    } catch { if (current === generation) failed(); }
  }
  const wake = () => { void connect(); };
  const suspend = () => { clear(); publish('suspended'); };
  const visibility = () => { if (active()) wake(); else suspend(); };
  window.addEventListener('online', wake);
  window.addEventListener('offline', suspend);
  window.addEventListener('pageshow', wake);
  window.addEventListener('pagehide', suspend);
  document.addEventListener('visibilitychange', visibility);
  void connect();
  return () => {
    stopped = true; clear();
    window.removeEventListener('online', wake);
    window.removeEventListener('offline', suspend);
    window.removeEventListener('pageshow', wake);
    window.removeEventListener('pagehide', suspend);
    document.removeEventListener('visibilitychange', visibility);
  };
}
