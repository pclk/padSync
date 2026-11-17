import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lassoStrokes, strokeBox } from "@/ink/geometry";
import { TILE_H, paintDelta, planTiles, sameVersions } from "@/ink/tiles";
import type { StrokeData, StrokeEntity } from "@/lib/types";

// Optimization sweep, ink: tiles only repaint what changed, lasso skips distant strokes, and the
// overlay does not recompute outlines every frame.

const render = vi.hoisted(() => ({ strokePath: vi.fn(() => ({ path: true })), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/ink/render", () => render);
vi.mock("@/lib/store", () => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: "new", kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

let n = 0;
function stroke(pts: [number, number][], over: Partial<StrokeData> & { hlc?: string; id?: string } = {}): StrokeEntity {
  const { hlc = "h0", id = `s${n++}`, ...data } = over;
  return {
    id,
    kind: "stroke",
    notebookId: "nb",
    parentId: "sec",
    hlc,
    deleted: 0,
    dirty: 0,
    data: { tool: "pen", color: "#000", size: 2, t0: n, input: "pen", device: "d", pts: pts.flatMap(([x, y]) => [x, y, 0.5, 1, 0, 0]), ...data },
  };
}

describe("tiles", () => {
  it("assigns strokes to every tile they touch", () => {
    const top = stroke([[10, 10]]);
    const straddle = stroke([[10, TILE_H - 1], [10, TILE_H + 1]]);
    const low = stroke([[10, TILE_H * 2 + 50]]);
    const tiles = planTiles(TILE_H * 3, [top, straddle, low]);
    expect(tiles.map((t) => t.strokes.map((s) => s.id))).toEqual([[top.id, straddle.id], [straddle.id], [low.id]]);
    expect(tiles.map((t) => [t.top, t.h])).toEqual([[0, TILE_H], [TILE_H, TILE_H], [TILE_H * 2, TILE_H]]);
  });

  it("sizes the last tile to the section", () => {
    expect(planTiles(TILE_H + 100, []).map((t) => t.h)).toEqual([TILE_H, 100]);
    expect(planTiles(0, [])).toHaveLength(1);
  });

  it("sameVersions compares id and hlc, not object identity", () => {
    const a = stroke([[0, 0]]);
    expect(sameVersions([a], [{ ...a, data: { ...a.data } }])).toBe(true);
    expect(sameVersions([a], [{ ...a, hlc: "h9" }])).toBe(false);
    expect(sameVersions([a], [])).toBe(false);
  });

  it("an unchanged tile keeps the same versions when another tile gains a stroke", () => {
    const a = stroke([[10, 10]]);
    const before = planTiles(TILE_H * 2, [a]);
    const after = planTiles(TILE_H * 2, [{ ...a }, stroke([[10, TILE_H + 50]])]);
    expect(sameVersions(before[0].strokes, after[0].strokes)).toBe(true);
    expect(sameVersions(before[1].strokes, after[1].strokes)).toBe(false);
  });
});

describe("paintDelta", () => {
  const pen1 = stroke([[0, 0]], { t0: 10 });
  const pen2 = stroke([[0, 0]], { t0: 20 });
  const hl = stroke([[0, 0]], { tool: "highlighter", t0: 30 });

  it("paints only a newer pen stroke on top", () => {
    expect(paintDelta([pen1], [pen1, pen2])?.map((s) => s.id)).toEqual([pen2.id]);
  });

  it("nothing to do when unchanged", () => {
    expect(paintDelta([pen1], [{ ...pen1 }])).toEqual([]);
  });

  it("repaints for a highlighter (it goes under the pens)", () => {
    expect(paintDelta([pen1], [pen1, hl])).toBeNull();
  });

  it("repaints for a pen stroke older than one already painted", () => {
    expect(paintDelta([pen2], [pen2, pen1])).toBeNull();
  });

  it("repaints when a stroke was removed or changed", () => {
    expect(paintDelta([pen1, pen2], [pen1])).toBeNull();
    expect(paintDelta([pen1, pen2], [pen1, { ...pen2, hlc: "moved" }])).toBeNull();
  });

  it("a highlighter already painted does not block new pens", () => {
    expect(paintDelta([hl, pen1], [hl, pen1, pen2])?.map((s) => s.id)).toEqual([pen2.id]);
  });
});

describe("lasso", () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];

  it("still picks strokes mostly inside and skips the rest", () => {
    const inside = stroke([[10, 10], [20, 20], [30, 30]]);
    const half = stroke([[50, 50], [150, 150]]);
    const mostlyOut = stroke([[50, 50], [150, 150], [160, 160]]);
    const far = stroke([[1000, 1000], [1010, 1010]]);
    expect(lassoStrokes([inside, half, mostlyOut, far], square).map((s) => s.id)).toEqual([inside.id, half.id]);
  });

  it("does not test the points of strokes outside the lasso bounds", () => {
    const far = stroke([[1000, 1000], [1010, 1010]]);
    strokeBox(far);
    const pts = far.data.pts;
    const spy = vi.fn();
    far.data.pts = new Proxy(pts, { get: (t, k) => (k !== "length" && typeof k === "string" && /^\d+$/.test(k) && spy(), Reflect.get(t, k)) });
    expect(lassoStrokes([far], square)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("controller overlay", () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    frames = [];
    render.strokePath.mockClear();
    render.seedPath.mockClear();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (frames.push(cb), frames.length));
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const flush = () => {
    const f = frames;
    frames = [];
    f.forEach((cb) => cb(0));
  };

  it("computes a committed stroke's outline once, not every frame, and seeds the tile cache", async () => {
    const { InkController } = await import("@/ink/controller");
    const c = new InkController("nb", { kind: "pen", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
    const ctx = { setTransform() {}, clearRect() {} };
    c.attachLive({ width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
    const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
    const sec = { id: "sec", el, strokes: () => [] };
    const ev = (type: string, x: number) => ({ type, pointerType: "pen", button: 0, pointerId: 1, clientX: x, clientY: x, pressure: 0.5, timeStamp: x, preventDefault() {} }) as unknown as PointerEvent;

    c.down(ev("pointerdown", 1), sec);
    c.move(ev("pointermove", 5), sec);
    c.up(ev("pointerup", 9));
    await Promise.resolve();
    await Promise.resolve();
    const atCommit = render.strokePath.mock.calls.length;
    for (let i = 0; i < 20; i++) flush();
    expect(render.strokePath.mock.calls.length).toBe(atCommit);
    expect(render.seedPath).toHaveBeenCalledWith(expect.objectContaining({ id: "new", hlc: "h1" }), { path: true });
  });
});
