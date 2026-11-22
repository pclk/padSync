import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as bridgeLive } from "@/app/api/bridge/live/route";
import { POST as threadLive } from "@/app/api/chat/threads/[id]/live/route";
import { createPollScheduler, pollDelay } from "@/lib/chat-ui";
import * as chat from "@/server/chat";
import { createDeviceToken } from "@/server/tokens";
import type { Sql } from "@/server/db";
import { configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";

// Realtime push for chat: the open chat and the Mac bridge watch live queries (bridge/live-query.ts)
// that wake them as soon as a turn changes or a job is queued; polling remains as a backup.

type Snap = { status: string; data?: unknown };
const subs: { cb: (s: Snap) => void; renew: ReturnType<typeof vi.fn> }[] = [];
vi.mock("@neon/realtime/client", () => ({
  createRealtimeClient: () => ({
    subscribe: () => {
      const sub = { cb: (() => {}) as (s: Snap) => void, renew: vi.fn(async () => {}) };
      subs.push(sub);
      return { onChange: (cb: (s: Snap) => void) => void (sub.cb = cb), renew: sub.renew };
    },
    close: () => {},
  }),
}));

describe("live query endpoints", () => {
  let sql: Sql;
  const saved = { ...process.env };
  beforeEach(async () => {
    configureAuthEnv();
    ({ sql } = await freshDb());
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("are disabled without Realtime, and need a session or a device token", async () => {
    delete process.env.NEON_REALTIME_URL;
    const t = (await chat.createThread(sql, { notebookId: "nb", title: "", agent: "claude", options: {} }))!;
    const res = await threadLive(req(`/api/chat/threads/${t.id}/live`, { method: "POST", session: sessionCookie() }), params({ id: t.id }));
    expect(await res.json()).toEqual({ enabled: false });
    expect((await threadLive(req("/api/chat/threads/nope/live", { method: "POST", session: sessionCookie() }), params({ id: "nope" }))).status).toBe(404);
    expect((await threadLive(req(`/api/chat/threads/${t.id}/live`, { method: "POST" }), params({ id: t.id }))).status).toBe(401);
    expect((await bridgeLive(req("/api/bridge/live", { method: "POST" }))).status).toBe(401);
  });

  it("seal a query for the thread, and for queued jobs", async () => {
    process.env.NEON_REALTIME_URL = "wss://live.test/realtime";
    process.env.NEON_REALTIME_SECRET = "nrt_live_1" + Buffer.alloc(32, 7).toString("base64url");
    process.env.DATABASE_URL = "postgres://u:p@db.test/neondb";
    const t = (await chat.createThread(sql, { notebookId: "nb", title: "", agent: "claude", options: {} }))!;
    const res = await threadLive(req(`/api/chat/threads/${t.id}/live`, { method: "POST", session: sessionCookie() }), params({ id: t.id }));
    const body = (await res.json()) as { enabled: boolean; url: string; query: { expiresAt: number } };
    expect(body).toMatchObject({ enabled: true, url: "wss://live.test/realtime" });
    expect(body.query.expiresAt).toBeGreaterThan(Date.now());
    const { token } = await createDeviceToken(sql, "Mac", "pclk");
    expect(await (await bridgeLive(req("/api/bridge/live", { method: "POST", bearer: token }))).json()).toMatchObject({ enabled: true });
  });
});

describe("watchLive", () => {
  beforeEach(() => {
    subs.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const cap = (expiresAt = Date.now() + 60_000) => ({ enabled: true as const, url: "wss://x", query: { expiresAt } as never });

  it("wakes on the first live result and on each change, not on repeats", async () => {
    const { watchLive } = await import("../bridge/live-query.ts");
    const onChange = vi.fn();
    const statuses: string[] = [];
    const stop = watchLive({ capability: async () => cap(), onChange, onStatus: (s) => statuses.push(s) });
    await vi.advanceTimersByTimeAsync(0);
    subs[0].cb({ status: "connecting" });
    subs[0].cb({ status: "live", data: [{ id: "a", status: "queued" }] });
    subs[0].cb({ status: "live", data: [{ id: "a", status: "queued" }] });
    subs[0].cb({ status: "live", data: [{ id: "a", status: "running" }] });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("live");
    stop();
  });

  it("renews before expiry, reconnects after an error, and stays quiet when disabled", async () => {
    const { watchLive } = await import("../bridge/live-query.ts");
    const capability = vi.fn(async () => cap());
    const statuses: string[] = [];
    const stop = watchLive({ capability, onChange: () => {}, onStatus: (s) => statuses.push(s) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(subs[0].renew).toHaveBeenCalledTimes(1);
    subs[0].cb({ status: "error" });
    expect(statuses.at(-1)).toBe("fallback");
    await vi.advanceTimersByTimeAsync(2000);
    expect(subs).toHaveLength(2);
    stop();

    const off = watchLive({ capability: async () => ({ enabled: false as const }), onChange: () => {}, onStatus: (s) => statuses.push(s) });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe("disabled");
    expect(subs).toHaveLength(2);
    off();
  });
});

describe("polling with realtime", () => {
  it("slows to a backup while live", () => {
    expect(pollDelay("thread", true, true)).toBe(3000);
    expect(pollDelay("thread", false, true)).toBe(30_000);
    expect(pollDelay("thread", true)).toBe(600);
  });

  it("a refresh during a request runs again as soon as it ends", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const request = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const poll = createPollScheduler(request, () => 30_000, () => true);
    poll.refresh();
    poll.refresh(); // a live notification while the first request is in flight
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    poll.stop();
    vi.useRealTimers();
  });
});

describe("device stamps kept with the turn", () => {
  it("merge into the trace, first stamp wins, and need a session", async () => {
    configureAuthEnv();
    const { sql } = await freshDb();
    const { POST: traceRoute } = await import("@/app/api/jobs/[id]/trace/route");
    const t = (await chat.createThread(sql, { notebookId: "nb", title: "", agent: "claude", options: {} }))!;
    const turn = (await chat.createTurn(sql, t.id, { question: "q", files: [], uploads: [], trace: { "client.sent": 1 } }))!;
    const post = (trace: unknown, session: string | false = sessionCookie()) =>
      traceRoute(req(`/api/jobs/${turn.jobId}/trace`, { body: { trace }, session }), params({ id: turn.jobId }));
    expect((await post({ "client.response": 5, "client.clock_offset": -400 })).status).toBe(200);
    expect((await post({ "client.response": 9, "client.done_seen": 12 })).status).toBe(200);
    expect((await post({ "bridge.claimed": 3 })).status).toBe(400);
    expect((await post({ "client.done_seen": 1 }, false)).status).toBe(401);
    const [row] = await chat.getTurns(sql, t.id);
    expect(row.trace).toMatchObject({ "client.sent": 1, "client.response": 5, "client.clock_offset": -400, "client.done_seen": 12 });
    expect(row.trace).not.toHaveProperty("bridge.claimed");
  });
});
