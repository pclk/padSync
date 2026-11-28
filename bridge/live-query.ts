import { createRealtimeClient, type RealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";

// Watches one Neon Realtime live query and calls onChange when its rows change. The rows are only a
// wake-up signal: callers fetch the real data over HTTP and keep polling, more slowly, as a backup.
// Shared by the chat panel (via src/lib/live-query.ts) and the Mac bridge, so it uses only erasable
// syntax and globals both have (fetch-era APIs, WebSocket).

export type LiveCapability = { enabled: true; url: string; query: SealedLiveQuery<Record<string, unknown>> } | { enabled: false };
export type LiveStatus = "connecting" | "live" | "fallback" | "disabled";

export function watchLive(o: {
  /** Asks padSync for a freshly sealed query; called again before each one expires. */
  capability: (signal: AbortSignal) => Promise<LiveCapability>;
  onChange: () => void;
  onStatus?: (status: LiveStatus) => void;
  /** Node only: the Origin to send, one the Realtime endpoint allows (browsers send their own). */
  origin?: string;
  /** Awaited before each connect, outside the capability timeout (the bridge waits out dark wakes). */
  ready?: (signal: AbortSignal) => Promise<void>;
}): () => void {
  let stopped = false;
  let generation = 0;
  let client: RealtimeClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let failures = 0;
  const status = (s: LiveStatus) => {
    if (!stopped) o.onStatus?.(s);
  };
  const clear = () => {
    generation++;
    clearTimeout(timer);
    request?.abort();
    request = undefined;
    client?.close();
    client = undefined;
  };
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(fn, ms);
  };
  const fetchCapability = () => {
    request = new AbortController();
    return o.capability(AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
  };
  const failed = () => {
    if (stopped) return;
    clear();
    status("fallback");
    later(() => void connect(), Math.min(60_000, 2000 * 2 ** Math.min(failures++, 5)));
  };
  const webSocketFactory = o.origin
    ? (url: string, protocols: string | string[]) =>
        // Node's WebSocket (undici) takes an options object with headers; browsers never get here.
        new WebSocket(url, { protocols, headers: { origin: o.origin } } as unknown as string[])
    : undefined;

  async function connect() {
    clear();
    if (stopped) return;
    status("connecting");
    const current = generation;
    try {
      if (o.ready) {
        request = new AbortController();
        await o.ready(request.signal);
        if (current !== generation) return;
      }
      const cap = await fetchCapability();
      if (current !== generation) return;
      if (!cap.enabled) {
        status("disabled");
        later(() => void connect(), 5 * 60_000);
        return;
      }
      client = createRealtimeClient({ url: cap.url, ...(webSocketFactory ? { webSocketFactory } : {}) });
      const subscription = client.subscribe(cap.query);
      let signature: string | undefined;
      let renewing = false;
      const renewAt = (expiresAt: number) => later(() => void renew(), Math.max(1000, expiresAt - Date.now() - 10_000));
      const renew = async () => {
        renewing = true;
        try {
          const next = await fetchCapability();
          if (current !== generation) return;
          if (!next.enabled) return failed();
          await subscription.renew(next.query);
          if (current === generation) renewAt(next.query.expiresAt);
        } catch {
          if (current === generation) failed();
        } finally {
          renewing = false;
        }
      };
      subscription.onChange((snap) => {
        if (current !== generation) return;
        if (snap.status === "error" || snap.status === "closed") return failed();
        // Stale: the query expired before its renewal (a slow clock); renew now.
        if (snap.status === "stale") {
          status("connecting");
          if (!renewing) void renew();
          return;
        }
        if (snap.status !== "live") return status("connecting");
        failures = 0;
        status("live");
        // The first live result counts as a change too: it covers whatever happened while away.
        const next = JSON.stringify(snap.data);
        if (next !== signature) {
          signature = next;
          o.onChange();
        }
      });
      renewAt(cap.query.expiresAt);
    } catch {
      if (current === generation) failed();
    }
  }

  void connect();
  return () => {
    stopped = true;
    clear();
  };
}
