import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";
import { dotCentre, isNativeStroke, strokeInput, strokeOptions } from "@/ink/render";
import type { StrokeData } from "@/lib/types";

// Strokes from the iPad app are PencilKit curves, sampled before 2026-11-22 at only one point
// per control point. The web's Pencil clean-up read a quick "=" bar as a tap and drew a dot, and
// streamline pulled short strokes' ends in.

const bar = (pk?: string): StrokeData => ({
  tool: "pen", color: "#000000", size: 2.2, input: "pen", device: "ipad", t0: 0, pk,
  // x, y, pressure, altitude, azimuth, t: three samples across 18 px in 40 ms
  pts: [100, 50, 0.5, 1.2, 0, 0, 109, 50, 0.5, 1.2, 0, 20, 118, 50, 0.5, 1.2, 0, 40],
});

const width = (d: StrokeData) => {
  const xs = getStroke(strokeInput(d), strokeOptions(d, true)).map((p) => p[0]);
  return Math.max(...xs) - Math.min(...xs);
};

describe("strokes from the iPad app", () => {
  it("are recognised by their PencilKit data", () => {
    expect(isNativeStroke(bar("AAAA"))).toBe(true);
    expect(isNativeStroke(bar())).toBe(false);
    expect(isNativeStroke(bar(""))).toBe(false);
  });

  it("keep a quick short bar as a bar, not a dot", () => {
    const native = bar("AAAA");
    expect(dotCentre(native)).toBeNull();
    expect(width(native)).toBeGreaterThan(17);
  });

  it("start and end where they were drawn", () => {
    const input = strokeInput(bar("AAAA"));
    expect(input[0].slice(0, 2)).toEqual([100, 50]);
    expect(input.at(-1)!.slice(0, 2)).toEqual([118, 50]);
  });
});
