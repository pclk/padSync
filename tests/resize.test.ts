import { describe, expect, it } from "vitest";
import { boxMap, mapBox, moveBoxWithin, resizeBox } from "@/ink/resize";

const b = { minX: 100, minY: 100, maxX: 300, maxY: 200 };
const page = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

describe("resizeBox", () => {
  it("moves only the dragged edges, the opposite ones stay put", () => {
    expect(resizeBox(b, "e", 50, 999)).toEqual({ minX: 100, minY: 100, maxX: 350, maxY: 200 });
    expect(resizeBox(b, "n", 999, -20)).toEqual({ minX: 100, minY: 80, maxX: 300, maxY: 200 });
    expect(resizeBox(b, "nw", -10, -30)).toEqual({ minX: 90, minY: 70, maxX: 300, maxY: 200 });
  });
  it("keeps the proportions from a corner, led by the axis dragged further", () => {
    expect(resizeBox(b, "se", 200, 10, { keepRatio: true })).toEqual({ minX: 100, minY: 100, maxX: 500, maxY: 300 });
    expect(resizeBox(b, "sw", 0, 50, { keepRatio: true })).toEqual({ minX: 0, minY: 100, maxX: 300, maxY: 250 });
  });
  it("grows a side about the centre with the ratio kept, and both ways from the centre", () => {
    expect(resizeBox(b, "e", 200, 0, { keepRatio: true })).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 250 });
    expect(resizeBox(b, "e", 50, 0, { fromCentre: true })).toEqual({ minX: 50, minY: 100, maxX: 350, maxY: 200 });
  });
  it("never flips past the opposite edge", () => {
    expect(resizeBox(b, "e", -500, 0, { min: 8 })).toEqual({ minX: 100, minY: 100, maxX: 108, maxY: 200 });
    const r = resizeBox(b, "se", -500, -500, { min: 8, keepRatio: true });
    expect(r.maxY - r.minY).toBe(8);
    expect(r.maxX - r.minX).toBe(16);
  });
  it("stops at the edges of `within`", () => {
    expect(resizeBox(b, "e", 5000, 0, { within: page }).maxX).toBe(1000);
    expect(resizeBox(b, "nw", -500, -500, { within: page })).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 200 });
    // With the ratio kept the tighter edge decides: the left runs out first.
    expect(resizeBox(b, "nw", -500, -500, { within: page, keepRatio: true })).toEqual({ minX: 0, minY: 50, maxX: 300, maxY: 200 });
  });
});

it("moveBoxWithin slides a box but keeps it inside", () => {
  expect(moveBoxWithin(b, -500, 20, page)).toEqual({ minX: 0, minY: 120, maxX: 200, maxY: 220 });
});

it("boxMap takes one box onto another", () => {
  const to = { minX: 0, minY: 50, maxX: 400, maxY: 100 };
  expect(mapBox(b, boxMap(b, to))).toEqual(to);
});
