import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";
import { STOP_RADIUS, TAIL_MAX_LENGTH, TAP_DOT_SIZE, collapseStops, tailTrim, tapDot, withoutLiftOff } from "@/ink/filters";
import { dotCentre, dotRadius, strokeOptions, toInput } from "@/ink/render";
import { strokePen } from "@/ink/pen-feel";
import type { StrokeData } from "@/lib/types";

// Blobs where the pen stops at a stroke's end, and dots that turned into dashes.

const pts = (list: [number, number, number][]) => list.flatMap(([x, y, p], i) => [x, y, p, 1, 0, i * 4]);
const pen = (p: number[]): StrokeData => ({ tool: "pen", color: "#000", size: 3.4, pts: p, t0: 0, input: "pen", device: "d" });

describe("collapseStops", () => {
  const xy = (list: [number, number][]) => list.map(([x, y]) => [x, y, 0.5]);
  const xs = (p: number[][]) => p.map(([x, y]) => [x, y]);

  it("drops the jitter where the pen rests before lifting, keeping the stop and the last point", () => {
    const line = xy([[0, 0], [5, 0], [10, 0], [10.4, 0.3], [9.8, -0.4], [10.2, 0.5], [10.5, 0]]);
    expect(xs(collapseStops(line))).toEqual([[0, 0], [5, 0], [10, 0], [10.5, 0]]);
  });

  it("drops the jitter where the pen lands, and leaves clean strokes alone", () => {
    const landing = xy([[0, 0], [0.5, 0.4], [-0.3, 0.2], [0.2, 0], [5, 0], [10, 0]]);
    expect(xs(collapseStops(landing))).toEqual([[0, 0], [0.2, 0], [5, 0], [10, 0]]);
    const clean = xy([[0, 0], [5, 0], [10, 0], [15, 0]]);
    expect(collapseStops(clean)).toBe(clean);
  });

  it("never shortens a stroke: the first and last points always stay; 0 turns it off", () => {
    const knot = xy([[0, 0], [0.2, 0], [0.4, 0], [0.6, 0], [0.8, 0]]);
    const out = collapseStops(knot);
    expect(out[0]).toBe(knot[0]);
    expect(out[out.length - 1]).toBe(knot[knot.length - 1]);
    const line = xy([[0, 0], [5, 0], [10, 0], [10.2, 0], [10.3, 0]]);
    expect(collapseStops(line, 0)).toBe(line);
    expect(STOP_RADIUS).toBeGreaterThan(0);
  });
});

describe("default settings keep every part of a letter", () => {
  // A light writer (pressure ~0.15) whose strokes ramp in and out, as in the alphabet sample:
  // with absolute hook thresholds and the tail cut, the top of an f and a 7, the bars of a z and
  // the end of an o disappeared.
  function letter(way: [number, number][]): StrokeData {
    const raw: [number, number][] = [];
    for (let k = 1; k < way.length; k++) {
      const [x0, y0] = way[k - 1], [x1, y1] = way[k];
      const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 0.9));
      for (let j = k === 1 ? 0 : 1; j <= n; j++) {
        const u = j / n;
        const e = u * u * (3 - 2 * u);
        raw.push([x0 + (x1 - x0) * e, y0 + (y1 - y0) * e]);
      }
    }
    const n = raw.length;
    return pen(raw.flatMap(([x, y], i) => [x, y, 0.15 * Math.min(1, (i + 1) / 6, (n - i) / 5), 1, 0, i * 4]));
  }
  const letters: Record<string, [number, number][]> = {
    f: [[9, 1], [6, -1], [4, 2], [4, 14]],
    "7": [[0, 0], [8, 0], [2, 13]],
    z: [[0, 4], [7, 4], [0, 12], [8, 12]],
    o: [[4, 4], [1, 7], [2, 11], [6, 12], [8, 8], [6, 4], [4, 4.5]],
  };
  for (const [name, way] of Object.entries(letters)) {
    it(`${name} keeps its first and last point`, () => {
      const out = toInput(letter(way).pts, "pen", strokePen({}));
      const [first, last] = [out[0], out[out.length - 1]];
      expect(Math.hypot(first[0] - way[0][0], first[1] - way[0][1])).toBeLessThan(0.5);
      expect(Math.hypot(last[0] - way[way.length - 1][0], last[1] - way[way.length - 1][1])).toBeLessThan(0.5);
    });
  }
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
  // The tail cut is off by default; these use the length it had when it was on.
  const endOf = (r: ReturnType<typeof path>, maxLength = 15, minTurn?: number) => {
    const [s, e] = tailTrim(r.input, r.raw, r.times, maxLength, minTurn);
    return { s, last: r.input[e - 1] };
  };

  it("cuts the fading hook at the end of a fraction bar", () => {
    const bar = path([10, 20], [{ to: [70, 20], speed: 1.5, p: [0.4, 0.4] }, { to: [60, 30], speed: 3, p: [0.35, 0.15] }]);
    expect(endOf(bar).last.slice(0, 2)).toEqual([70, 20]);
  });

  it("keeps a fast turn at full pressure: fast alone is part of the letter", () => {
    const bar = path([10, 20], [{ to: [70, 20], speed: 1, p: [0.4, 0.4] }, { to: [62, 28], speed: 4, p: [0.4, 0.4] }]);
    expect(endOf(bar).last.slice(0, 2)).toEqual([62, 28]);
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
    expect(TAIL_MAX_LENGTH).toBe(0);
    expect(tailTrim(bar.input, bar.raw, bar.times)).toEqual([0, bar.input.length]);
  });
});

describe("Safari's lift-off point", () => {
  // A line to the right whose pointerup sample (pressure 0) hooks back down and left, as on the iPad.
  const line = pts([[0, 0, 0.2], [2, 0, 0.2], [4, 0, 0.2], [6, 0, 0.2], [8, 0, 0.15], [6, 3, 0]]);
  const xs = (p: number[][]) => p.map(([x, y]) => [x, y]);

  it("is drawn by default, so no ink goes missing", () => {
    const out = toInput(line, "pen");
    expect(xs(out).at(-1)).toEqual([6, 3]);
  });

  it("is left out when the pen setting asks for it; the last pressed point ends the stroke", () => {
    const out = toInput(line, "pen", { ...strokePen({}), dropLiftOff: true });
    expect(xs(out).at(-1)).toEqual([8, 0]);
    expect(out.every(([, y]) => Math.abs(y) < 1e-9)).toBe(true);
  });

  it("only drops a zero-pressure last point, and never from a stroke shorter than three points", () => {
    const pressed = pts([[0, 0, 0.2], [2, 0, 0.2], [4, 0, 0.1]]);
    expect(withoutLiftOff(pressed)).toBe(pressed);
    const tap = pts([[0, 0, 0.2], [1, 1, 0]]);
    expect(withoutLiftOff(tap)).toBe(tap);
    expect(withoutLiftOff(pts([[0, 0, 0.2], [1, 0, 0.2], [3, 2, 0]]))).toEqual(pts([[0, 0, 0.2], [1, 0, 0.2]]));
  });

  it("doesn't count towards a tap's size when left out: a dot with a long lift-off slide stays a dot", () => {
    // Firm and still, then the up sample lands 9 units away: too spread out for a dot when drawn.
    const tap = pts([[0, 0, 0.2], [0.2, 0, 0.22], [0.2, 0.2, 0.2], [0.6, 0.4, 0.12], [7, 6, 0]]);
    expect(dotCentre(pen(tap))).toBeNull();
    expect(dotCentre({ ...pen(tap), pen: { dropLiftOff: true } })).not.toBeNull();
  });
});
