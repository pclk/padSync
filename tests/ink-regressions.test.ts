import { describe, expect, it } from "vitest";
import { hitStrokes, dataBox } from "@/ink/geometry";
import { planTiles, paintDelta, TILE_H } from "@/ink/tiles";
import type { StrokeEntity } from "@/lib/types";

let serial = 0;
function stroke(points: number[][], size = 0): StrokeEntity {
  return { id: `regression-${serial++}`, hlc: "1", kind: "stroke", notebookId: "n", parentId: "s", deleted: 0, dirty: 0,
    data: { pts: points.flatMap(([x, y]) => [x, y, .5, 1, 0, 0]), size, tool: "pen", color: "#000", t0: 1, input: "pen", device: "d" } };
}

describe("continuous eraser geometry", () => {
  it.each([
    ["crossing between old sample positions", [[12, -10], [12, 10]], [0, 0, 100, 0], 0, true],
    ["reversed crossing", [[12, 10], [12, -10]], [100, 0, 0, 0], 0, true],
    ["extension crossing outside segment", [[12, 1], [12, 10]], [0, 0, 100, 0], 0, false],
    ["collinear overlap", [[12, 0], [30, 0]], [0, 0, 100, 0], 0, true],
    ["collinear disjoint", [[101, 0], [130, 0]], [0, 0, 100, 0], 0, false],
    ["parallel tangent", [[12, 2], [30, 2]], [0, 0, 100, 0], 2, true],
    ["parallel near miss", [[12, 2.001], [30, 2.001]], [0, 0, 100, 0], 2, false],
    ["shared endpoint", [[100, 0], [100, 10]], [0, 0, 100, 0], 0, true],
    ["stationary eraser", [[-10, 0], [10, 0]], [0, 0, 0, 0], 0, true],
    ["single point stroke", [[12, 0]], [0, 0, 100, 0], 0, true],
    ["repeated stroke points", [[12, 0], [12, 0]], [0, 0, 100, 0], 0, true],
    ["both stationary tangent", [[3, 4]], [0, 0, 0, 0], 5, true],
    ["empty stroke", [], [0, 0, 100, 0], 5, false],
  ] as [string, number[][], number[], number, boolean][]) ("%s", (_, points, eraser, radius, hit) => {
    const s = stroke(points);
    expect(hitStrokes([s], eraser[0], eraser[1], eraser[2], eraser[3], radius)).toEqual(hit ? [s] : []);
  });
  it("includes half the stroke width and preserves input order", () => {
    const a = stroke([[12, 3]], 4), b = stroke([[13, 3.01]], 4), c = stroke([[14, 0]], 4);
    expect(hitStrokes([a, b, c], 0, 0, 100, 0, 1)).toEqual([a, c]);
  });
});

describe("tile assignment against independent rectangle overlap", () => {
  it.each([0, 1, TILE_H, TILE_H + 17, TILE_H * 4])("matches inclusive overlap at height %s", (height) => {
    const strokes = [-20, 0, 1, TILE_H - 2, TILE_H, TILE_H + 2, height, height + 2].flatMap(y =>
      [0, 2].map(size => stroke([[0, y]], size)));
    strokes.push(stroke([]), stroke([[0, -50], [0, TILE_H * 5]]));
    const actual = planTiles(height, strokes);
    expect(actual).toEqual(Array.from({ length: Math.max(1, Math.ceil(height / TILE_H)) }, (_, i) => {
      const top = i * TILE_H, h = Math.min(TILE_H, height - top);
      return { top, h, strokes: strokes.filter(s => { const b = dataBox(s.data); return b.maxY >= top && b.minY <= top + h; }) };
    }));
  });
  it("matches overlap for deterministic varied spans and keeps painting order", () => {
    let seed = 917;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const strokes = Array.from({ length: 1000 }, () => stroke([[0, random() * 12000 - 1000], [0, random() * 12000 - 1000]], random() * 30));
    for (const tile of planTiles(10001, strokes)) {
      expect(tile.strokes).toEqual(strokes.filter(s => { const b = dataBox(s.data); return b.maxY >= tile.top && b.minY <= tile.top + tile.h; }));
    }
  });
});

it("repaints when equal-time pens change their relative painting order", () => {
  const a = stroke([[0, 0]]), b = stroke([[0, 0]]);
  expect(paintDelta([a, b], [b, a])).toBeNull();
});
