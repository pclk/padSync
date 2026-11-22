// The iPad app's realtime bridge: the web's own Neon client (src/lib/sync-realtime.ts uses the same
// one) in a hidden WKWebView. Swift (Sync/Realtime.swift) fetches the capability and runs the
// reconnect and renewal state machine; this only holds the socket and reports each snapshot.
import { createRealtimeClient, type MaterializedLiveQuerySubscription, type RealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";

type Hint = { id: string; seq: string };
type Message = { generation: number; status: string; error?: string; signature?: string };
declare global {
  interface Window {
    webkit: { messageHandlers: { realtime: { postMessage(message: Message): void } } };
    padsyncRealtime: typeof bridge;
  }
}

let client: RealtimeClient | undefined;
let subscription: MaterializedLiveQuerySubscription<Hint> | undefined;
let current = 0;

const bridge = {
  connect(generation: number, url: string, query: SealedLiveQuery<Hint>) {
    bridge.close();
    current = generation;
    client = createRealtimeClient({ url });
    const sub = client.subscribe(query);
    subscription = sub;
    const report = (snapshot: ReturnType<typeof sub.getSnapshot>) => {
      if (generation !== current) return;
      const message: Message = { generation, status: snapshot.status };
      if (snapshot.status === "error") message.error = snapshot.error?.code ?? "unknown";
      if (snapshot.status === "live") message.signature = JSON.stringify(snapshot.data);
      window.webkit.messageHandlers.realtime.postMessage(message);
    };
    sub.onChange(report);
    // onChange only reports changes; send the starting state too.
    report(sub.getSnapshot());
  },
  async renew(generation: number, query: SealedLiveQuery<Hint>) {
    if (generation !== current || !subscription) throw new Error("No subscription to renew");
    await subscription.renew(query);
  },
  close() {
    const old = client;
    client = undefined;
    subscription = undefined;
    current = 0;
    old?.close();
  },
};
window.padsyncRealtime = bridge;
