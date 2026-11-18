import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStroke } from "perfect-freehand";
import { BACKTRACK_MAX, HOOK_MAX_LENGTH, MAX_POINT_GAP, dropBacktracks, hookTrim, interpolateGaps, smoothPositions } from "@/ink/filters";
import { strokeOptions, toInput } from "@/ink/render";
import type { StrokeData, StrokeEntity } from "@/lib/types";

// iPad Pencil lines looked like a chain of pinched pieces, one per frame: a sample landing a
// couple of samples behind the tip folds the outline back on itself. Re-sent samples are dropped
// at capture (older timestamp) and at render (single backward steps), and positions are smoothed
// along the stroke so dense 240 Hz input is as calm as trackpad input.

const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `s${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

/** A horizontal 240 Hz line at 800 px/s; every 4th sample (once per frame) jumps 2 samples back. */
function framedLine(backtrack: boolean): StrokeData {
  const pts: number[] = [];
  const step = 800 / 240;
  let t = 0;
  for (let i = 0; i < 90; i++) {
    const x = 20 + i * step;
    if (backtrack && i % 4 === 0 && i) pts.push(x - 2 * step, 50, 0.4, 1, 0, t);
    pts.push(x, 50, 0.4, 1, 0, t);
    t += 4;
  }
  return { tool: "pen", color: "#000", size: 3.4, pts, t0: 0, input: "pen", device: "d" };
}

/** How often the outline polygon crosses itself: each fold is a pinch with a seam. */
function selfCrossings(d: StrokeData) {
  const o = getStroke(toInput(d.pts, d.input), strokeOptions(d, true));
  const cross = (a: number[], b: number[], c: number[], e: number[]) => {
    const r = (p: number[], q: number[], s: number[]) => (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]);
    return r(a, b, c) * r(a, b, e) < 0 && r(c, e, a) * r(c, e, b) < 0;
  };
  let n = 0;
  for (let i = 0; i < o.length; i++)
    for (let j = i + 2; j < o.length; j++) {
      if (i === 0 && j === o.length - 1) continue;
      if (cross(o[i], o[(i + 1) % o.length], o[j], o[(j + 1) % o.length])) n++;
    }
  return n;
}

describe("dropBacktracks", () => {
  const line = (xs: number[]) => xs.map((x) => [x, 0, 0.5]);

  it("drops a sample that steps back and is then passed again", () => {
    expect(dropBacktracks(line([0, 3, 6, 4, 9, 12])).map(([x]) => x)).toEqual([0, 3, 6, 9, 12]);
  });

  it("keeps a real reversal, such as an arrowhead drawn back over the line", () => {
    const xs = [0, 3, 6, 9, 7, 5, 3];
    expect(dropBacktracks(line(xs)).map(([x]) => x)).toEqual(xs);
  });

  it("keeps a large backward jump, and always keeps the first and last points", () => {
    const xs = [0, 3, 6, 6 - BACKTRACK_MAX - 1, 9, 12];
    expect(dropBacktracks(line(xs)).map(([x]) => x)).toEqual(xs);
    expect(dropBacktracks(line([0, 3, 6, 4])).map(([x]) => x)).toEqual([0, 3, 6, 4]);
  });

  it("drops samples whose time runs backwards", () => {
    const pts = line([0, 3, 6, 7, 9, 12]);
    expect(dropBacktracks(pts, [0, 4, 8, 2, 12, 16]).map(([x]) => x)).toEqual([0, 3, 6, 9, 12]);
  });

  it("returns the same array when nothing is dropped", () => {
    const pts = line([0, 3, 6, 9, 12]);
    expect(dropBacktracks(pts)).toBe(pts);
  });
});

describe("smoothPositions", () => {
  it("evens out jitter but keeps the ends and the pressure", () => {
    const pts = Array.from({ length: 60 }, (_, i) => [i * 1.2, i % 2 ? 0.6 : -0.6, 0.3 + i / 100]);
    const out = smoothPositions(pts);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
    const mid = out.slice(10, 50);
    expect(Math.max(...mid.map(([, y]) => Math.abs(y)))).toBeLessThan(0.2);
    expect(mid.map(([, , p]) => p)).toEqual(pts.slice(10, 50).map(([, , p]) => p));
  });

  it("barely moves a corner", () => {
    const pts: number[][] = [];
    for (let i = 0; i <= 20; i++) pts.push([i, 0, 0.5]);
    for (let i = 1; i <= 20; i++) pts.push([20, i, 0.5]);
    const corner = smoothPositions(pts)[20];
    expect(Math.hypot(corner[0] - 20, corner[1])).toBeLessThan(1);
  });
});

describe("interpolateGaps", () => {
  it("curves through sparse samples, keeping every sample and the spacing small", () => {
    // A circle of radius 6 sampled 8 times (like a fast "o" at one sample per frame).
    const pts = Array.from({ length: 9 }, (_, i) => [6 * Math.cos((i * Math.PI) / 4), 6 * Math.sin((i * Math.PI) / 4), 0.5]);
    const out = interpolateGaps(pts);
    for (const p of pts) expect(out).toContainEqual(p);
    for (let i = 1; i < out.length; i++) expect(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])).toBeLessThanOrEqual(MAX_POINT_GAP + 0.3);
    // Between samples the curve bulges out towards the circle instead of cutting the chord.
    const mid = out.slice(1, -1).filter((p) => !pts.includes(p));
    const chord = 6 * Math.cos(Math.PI / 8);
    expect(Math.max(...mid.map(([x, y]) => Math.hypot(x, y)))).toBeGreaterThan(chord + 0.3);
  });

  it("returns dense input unchanged", () => {
    const pts = Array.from({ length: 10 }, (_, i) => [i, 0, 0.5]);
    expect(interpolateGaps(pts)).toBe(pts);
  });
});

describe("hookTrim", () => {
  const line = (n: number) => Array.from({ length: n }, (_, i) => [i, 0, 0.5]);

  it("cuts the light touchdown and lift-off ends", () => {
    const raw = [0.02, 0.06, 0.3, 0.4, 0.4, 0.4, 0.3, 0.05, 0];
    expect(hookTrim(line(9), raw)).toEqual([2, 7]);
  });

  it("never cuts more than HOOK_MAX_LENGTH from an end, or below two points", () => {
    const raw = Array.from({ length: 20 }, () => 0.01);
    const [start, end] = hookTrim(line(20), raw);
    expect(start).toBeLessThanOrEqual(HOOK_MAX_LENGTH);
    expect(end - start).toBeGreaterThanOrEqual(2);
    const [s3, e3] = hookTrim(line(3), [0, 0, 0]);
    expect(e3 - s3).toBe(2);
  });
});

describe("rendered iPad line", () => {
  it("has no per-frame pinches when samples jump back once per frame", () => {
    expect(selfCrossings(framedLine(true))).toBe(selfCrossings(framedLine(false)));
  });
});

describe("capture", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} quadraticCurveTo() {} arc() {} closePath() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does not store a coalesced sample older than the last one", async () => {
    const { InkController } = await import("@/ink/controller");
    const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
    const c = new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
    const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
    const sec = { id: "sec", el, strokes: () => [] };
    const ev = (type: string, x: number, t: number, coalesced?: PointerEvent[]) =>
      ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, clientX: x, clientY: 10, pressure: 0.5, timeStamp: t, preventDefault() {}, getCoalescedEvents: coalesced && (() => coalesced) }) as unknown as PointerEvent;
    c.down(ev("pointerdown", 0, 100), sec);
    c.move(ev("pointermove", 8, 108, [ev("pointermove", 4, 104), ev("pointermove", 8, 108)]), sec);
    // The next frame hands over the sample from 104 ms again before the new ones.
    c.move(ev("pointermove", 16, 116, [ev("pointermove", 4, 104), ev("pointermove", 12, 112), ev("pointermove", 16, 116)]), sec);
    c.up(ev("pointerup", 16, 117));
    await vi.waitFor(() => expect(store.putEntities).toHaveBeenCalledTimes(1));
    const data = store.putEntities.mock.calls[0][0][0].data as StrokeData;
    const xs = data.pts.filter((_, i) => i % 6 === 0);
    expect(xs).toEqual([0, 4, 8, 12, 16]);
  });
});
