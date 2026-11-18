import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";
import { STOP_RADIUS, TAIL_MAX_LENGTH, TAP_DOT_SIZE, tailTrim, tapDot, trimStops } from "@/ink/filters";
import { dotCentre, dotRadius, strokeOptions, toInput } from "@/ink/render";
import { strokePen } from "@/ink/pen-feel";
import type { StrokeData } from "@/lib/types";

// Blobs where the pen stops at a stroke's end, and dots that turned into dashes.

const pts = (list: [number, number, number][]) => list.flatMap(([x, y, p], i) => [x, y, p, 1, 0, i * 4]);
const pen = (p: number[]): StrokeData => ({ tool: "pen", color: "#000", size: 3.4, pts: p, t0: 0, input: "pen", device: "d" });

describe("trimStops", () => {
  const xy = (list: [number, number][]) => list.map(([x, y]) => [x, y, 0.5]);

  it("collapses the knot where the pen rests before lifting", () => {
    const line = xy([[0, 0], [5, 0], [10, 0], [10.4, 0.3], [9.8, -0.4], [10.2, 0.5], [10.5, 0]]);
    expect(trimStops(line)).toEqual([0, 3]);
  });

  it("collapses the knot where the pen lands, and leaves clean strokes alone", () => {
    const landing = xy([[0, 0], [0.5, 0.4], [-0.3, 0.2], [0.2, 0], [5, 0], [10, 0]]);
    expect(trimStops(landing)).toEqual([3, 6]);
    const clean = xy([[0, 0], [5, 0], [10, 0], [15, 0]]);
    expect(trimStops(clean)).toEqual([0, 4]);
  });

  it("keeps at least two points, and 0 turns it off", () => {
    const knot = xy([[0, 0], [0.2, 0], [0.4, 0], [0.6, 0]]);
    const [s, e] = trimStops(knot);
    expect(e - s).toBeGreaterThanOrEqual(2);
    expect(trimStops(xy([[0, 0], [5, 0], [10, 0], [10.2, 0]]), 0)).toEqual([0, 4]);
    expect(STOP_RADIUS).toBeGreaterThan(0);
  });
});

describe("taps drawn as dots", () => {
  // Lands, presses, then slides 4 px sideways while the pressure falls away.
  const tap = pts([[10, 10, 0.2], [10.2, 10.1, 0.4], [10.1, 9.9, 0.5], [10.3, 10, 0.5], [11.2, 10.2, 0.25], [12.4, 10.4, 0.15], [13.8, 10.6, 0.08]]);
  // A deliberate short dash: 5 px at steady pressure.
  const dash = pts(Array.from({ length: 12 }, (_, i) => [10 + i * 0.45, 10, 0.45] as [number, number, number]));

  it("a tap with a lift-off slide becomes a round dot where it was pressed", () => {
    expect(tapDot(tap)).toEqual([10.1, 9.9]);
    expect(dotCentre(pen(tap))).toEqual([10.1, 9.9]);
  });

  it("a short deliberate dash stays a dash", () => {
    expect(tapDot(dash)).toBeNull();
  });

  it("a quick flick (the bar of a 5) is not a dot", () => {
    const flick = pts([[10, 10, 0.55], [11, 10, 0.45], [12, 10, 0.35], [13, 10, 0.3], [14, 10, 0.25], [15, 10, 0.2], [16, 10, 0.15]]);
    expect(tapDot(flick)).toBeNull();
  });

  it("a letter that ends in a hard press is not a dot", () => {
    const letter = pts([[0, 0, 0.4], [4, 6, 0.4], [8, 0, 0.4], [8.2, 0.1, 0.9], [8.1, 0, 0.9]]);
    expect(tapDot(letter)).toBeNull();
  });

  it("can be turned off", () => {
    expect(tapDot(tap, 0)).toBeNull();
    expect(dotCentre({ ...pen(tap), pen: { tapDotSize: 0 } })).toBeNull();
    expect(TAP_DOT_SIZE).toBeGreaterThan(0);
  });

  it("a dot is as wide as the line at the same pressure", () => {
    const line = pen(pts(Array.from({ length: 40 }, (_, i) => [i * 3, 50, 0.5] as [number, number, number])));
    const outline = getStroke(toInput(line.pts, "pen", strokePen(line)), strokeOptions(line, true));
    const ys = outline.filter(([x]) => Math.abs(x - 60) < 4).map(([, y]) => y);
    const width = Math.max(...ys) - Math.min(...ys);
    const dot = pen(pts([[10, 10, 0.5], [10.2, 10, 0.5]]));
    expect(2 * dotRadius(dot)).toBeCloseTo(width, 0);
  });
});

describe("lift-off tails", () => {
  // Points along a polyline: `speed` units per 4 ms sample, pressure fading from p[0] to p[1].
  function path(from: [number, number], segs: { to: [number, number]; speed: number; p: [number, number] }[]) {
    const input: number[][] = [];
    const raw: number[] = [];
    const times: number[] = [];
    let [x, y] = from;
    let t = 0;
    input.push([x, y, segs[0].p[0]]);
    raw.push(segs[0].p[0]);
    times.push(0);
    for (const s of segs) {
      const n = Math.max(1, Math.round(Math.hypot(s.to[0] - x, s.to[1] - y) / s.speed));
      const [x0, y0] = [x, y];
      for (let i = 1; i <= n; i++) {
        t += 4;
        [x, y] = [x0 + ((s.to[0] - x0) * i) / n, y0 + ((s.to[1] - y0) * i) / n];
        const p = s.p[0] + ((s.p[1] - s.p[0]) * i) / n;
        input.push([x, y, p]);
        raw.push(p);
        times.push(t);
      }
    }
    return { input, raw, times };
  }
  const endOf = (r: ReturnType<typeof path>, ...rest: [number?, number?]) => {
    const [s, e] = tailTrim(r.input, r.raw, r.times, ...rest);
    return { s, last: r.input[e - 1] };
  };

  it("cuts the fading hook at the end of a fraction bar", () => {
    const bar = path([10, 20], [{ to: [70, 20], speed: 1.5, p: [0.4, 0.4] }, { to: [60, 30], speed: 3, p: [0.35, 0.15] }]);
    expect(endOf(bar).last.slice(0, 2)).toEqual([70, 20]);
  });

  it("cuts a fast tail even at full pressure", () => {
    const bar = path([10, 20], [{ to: [70, 20], speed: 1, p: [0.4, 0.4] }, { to: [62, 28], speed: 4, p: [0.4, 0.4] }]);
    expect(endOf(bar).last.slice(0, 2)).toEqual([70, 20]);
  });

  it("cuts the tail a 0 gets inside it, and a light landing tail", () => {
    const zero = path([192, 12], [
      { to: [190, 30], speed: 1.5, p: [0.4, 0.4] },
      { to: [200, 30], speed: 1.5, p: [0.4, 0.4] },
      { to: [196, 11], speed: 1.5, p: [0.4, 0.4] },
      { to: [193, 18], speed: 3, p: [0.35, 0.12] },
    ]);
    expect(endOf(zero).last.slice(0, 2)).toEqual([196, 11]);
    const landing = path([8, 6], [{ to: [4, 0], speed: 3, p: [0.1, 0.3] }, { to: [60, 0], speed: 1.5, p: [0.4, 0.4] }]);
    expect(landing.input[endOf(landing).s].slice(0, 2)).toEqual([4, 0]);
  });

  it("keeps firm, steady turns: the foot of a 2 and the hook of a J", () => {
    const two = path([128, 14], [{ to: [140, 12], speed: 1.2, p: [0.4, 0.4] }, { to: [130, 30], speed: 1.2, p: [0.4, 0.45] }, { to: [140, 30], speed: 1.2, p: [0.45, 0.4] }]);
    expect(endOf(two).last.slice(0, 2)).toEqual([140, 30]);
    const j = path([170, 10], [{ to: [170, 28], speed: 1.2, p: [0.4, 0.4] }, { to: [162, 31], speed: 1.2, p: [0.4, 0.38] }]);
    expect(endOf(j).last.slice(0, 2)).toEqual([162, 31]);
  });

  it("is off at 0 length, and a gentle bend is never a tail", () => {
    const bar = path([10, 20], [{ to: [70, 20], speed: 1.5, p: [0.4, 0.4] }, { to: [60, 30], speed: 3, p: [0.35, 0.15] }]);
    expect(endOf(bar, 0).last.slice(0, 2)).toEqual([60, 30]);
    const bend = path([0, 0], [{ to: [60, 0], speed: 1.5, p: [0.4, 0.4] }, { to: [70, 4], speed: 3, p: [0.35, 0.15] }]);
    expect(endOf(bend).last.slice(0, 2)).toEqual([70, 4]);
    expect(TAIL_MAX_LENGTH).toBeGreaterThan(0);
  });
});
