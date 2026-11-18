import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";
import { STOP_RADIUS, TAP_DOT_SIZE, tapDot, trimStops } from "@/ink/filters";
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
