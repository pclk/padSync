import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StrokeData, StrokeEntity } from "@/lib/types";

// Fixes from the 2026-11-18 review of the overnight commits (roadmap "Final pass").

const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `s${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
const render = vi.hoisted(() => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/ink/render", () => render);
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));
vi.mock("@/lib/sync-realtime", () => ({ startRealtime: () => () => {} }));

const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
const rect = () => ({ left: 0, top: 0 });
const section = (id: string) => ({ id, el: { getBoundingClientRect: rect, setPointerCapture() {} } as unknown as HTMLElement, strokes: () => [] });
const ev = (type: string, pointerId: number, x: number, extra: Record<string, unknown> = {}) =>
  ({ type, pointerType: "pen", button: 0, buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0, pointerId, clientX: x, clientY: x, pressure: 0.5, timeStamp: x * 10, preventDefault() {}, ...extra }) as unknown as PointerEvent;
const committed = () => store.putEntities.mock.calls.map(([rows]) => (rows[0].data as StrokeData).pts.length / 6);
const canvas = () => {
  const ctx = new Proxy({}, { get: () => () => {} });
  return { width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: rect } as unknown as HTMLCanvasElement;
};

async function setup() {
  const { InkController } = await import("@/ink/controller");
  return new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
}

describe("pencil path", () => {
  let frames: FrameRequestCallback[] = [];
  const flush = () => {
    const f = frames;
    frames = [];
    f.forEach((cb) => cb(0));
  };
  beforeEach(() => {
    store.putEntities.mockClear();
    render.paintStroke.mockClear();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a stale section losing capture does not end the new stroke that reused its pointerId", async () => {
    const c = await setup();
    const a = section("a");
    const b = section("b");
    c.down(ev("pointerdown", 1, 1), a);
    c.move(ev("pointermove", 1, 5), a);
    // pointerup lost; the next touch reuses pointerId 1 on section b, which takes capture from a.
    c.down(ev("pointerdown", 1, 20), b);
    c.lostCapture(ev("lostpointercapture", 1, 20), a);
    expect(c.isDrawing()).toBe(true);
    c.move(ev("pointermove", 1, 30), b);
    c.up(ev("pointerup", 1, 30));
    expect(committed()).toEqual([2, 2]);
  });

  it("closing the editor mid-stroke commits the stroke instead of dropping it", async () => {
    const c = await setup();
    c.attachLive(canvas());
    c.down(ev("pointerdown", 1, 1), section("a"));
    c.move(ev("pointermove", 1, 5), section("a"));
    c.attachLive(null);
    expect(c.isDrawing()).toBe(false);
    expect(committed()).toEqual([2]);
  });

  it("a just-committed stroke on a section that unmounted doesn't stop the live overlay drawing", async () => {
    const c = await setup();
    c.attachLive(canvas());
    let el: HTMLElement | null = section("a").el;
    const a = { id: "a", get el() { return el!; }, strokes: () => [] };
    c.down(ev("pointerdown", 1, 1), a);
    c.move(ev("pointermove", 1, 5), a);
    c.up(ev("pointerup", 1, 6));
    await Promise.resolve();
    el = null; // section deleted before its tile painted the stroke
    const b = section("b");
    c.down(ev("pointerdown", 2, 10), b);
    c.move(ev("pointermove", 2, 15), b);
    render.paintStroke.mockClear();
    expect(() => flush()).not.toThrow();
    expect(render.paintStroke).toHaveBeenCalledTimes(1); // the live stroke on b
  });
});

describe("sync badge hydration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("server-renders without the remembered lastSyncedAt, matching the prerendered page", async () => {
    vi.resetModules();
    const stored = String(Date.now() - 120_000);
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem() {} });
    const { getSyncState } = await import("@/lib/sync");
    expect(getSyncState().lastSyncedAt).toBe(Number(stored));
    const { SyncBadge } = await import("@/components/SyncBadge");
    const { formatLastSynced } = await import("@/lib/sync-status");
    const html = renderToStaticMarkup(createElement(SyncBadge));
    expect(html).toContain(formatLastSynced(0, Date.now()));
    expect(html).not.toContain(formatLastSynced(Number(stored), Date.now()));
  });
});
