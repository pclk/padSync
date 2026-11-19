import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lassoStrokes } from "@/ink/geometry";
import { defaultLasso, normalizeLasso, visibleLassoActions } from "@/lib/lasso-settings";
import { DEFAULT_TUNING } from "@/lib/touch-gestures";
import type { StrokeEntity } from "@/lib/types";

// A stroke from points [x, y, ...] with the stride's other fields filled in.
const stroke = (id: string, xy: number[], size = 3) => {
  const pts: number[] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push(xy[i], xy[i + 1], 0.5, 1, 0, i);
  return { id, kind: "stroke", data: { tool: "pen", color: "#000", size, pts, t0: 0 } } as unknown as StrokeEntity;
};
// A loop around (100..200, 100..200), drawn as a path.
const loop = [[100, 100], [200, 100], [200, 200], [100, 200], [100, 101]];

describe("what the lasso picks", () => {
  const inside = stroke("in", [120, 120, 180, 180]);
  const crossed = stroke("crossed", [150, 40, 150, 90, 150, 110]); // mostly above, its end inside
  const grazed = stroke("grazed", [90, 150, 98.6, 150]); // ends just short of the left edge, within its width
  const over = stroke("over", [150, 60, 150, 140, 150, 260, 150, 300]); // crosses right through, few points inside
  const far = stroke("far", [400, 400, 450, 450]);
  const all = [inside, crossed, grazed, over, far];

  it("by default takes anything the lasso touches", () => {
    expect(defaultLasso(true).mode).toBe("touch");
    expect(lassoStrokes(all, loop, "touch").map((s) => s.id)).toEqual(["in", "crossed", "grazed", "over"]);
  });

  it("can take only what it encloses", () => {
    expect(lassoStrokes(all, loop, "enclose").map((s) => s.id)).toEqual(["in"]);
  });
});

describe("lasso settings", () => {
  it("shows the circle by default on the iPad, the bar on the Mac", () => {
    expect(defaultLasso(true).circle).toBe(true);
    expect(defaultLasso(false).circle).toBe(false);
    expect(normalizeLasso(undefined, false)).toEqual(defaultLasso(false));
  });

  it("mends what was stored, keeping the order and adding new actions", () => {
    const s = normalizeLasso({ mode: "enclose", order: ["done", "delete", "nope"], hidden: ["ask"], size: 999, step: 1 }, true);
    expect(s.mode).toBe("enclose");
    expect(s.order.slice(0, 2)).toEqual(["done", "delete"]);
    expect(s.order).toHaveLength(7);
    expect(visibleLassoActions(s)).not.toContain("ask");
    expect(s.size).toBe(96);
    expect(s.step).toBe(5);
  });

  it("holds for a lasso in half the time it used to", () => {
    expect(DEFAULT_TUNING.holdMs).toBe(250);
  });
});

// --- recolouring and resizing a selection, undoably ---------------------------------------------
const rows = new Map<string, StrokeEntity>();
const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (list: StrokeEntity[]) => {
    for (const r of list) rowsRef.rows.set(r.id, r);
    return list;
  }),
  newEntity: vi.fn(),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
const rowsRef = vi.hoisted(() => ({ rows: new Map<string, StrokeEntity>() }));
vi.mock("@/ink/render", () => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: { entities: { bulkGet: async (ids: string[]) => ids.map((id) => rowsRef.rows.get(id)) } }, deviceId: () => "dev" }));

beforeEach(() => {
  rows.clear();
  rowsRef.rows.clear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
});
afterEach(() => vi.unstubAllGlobals());

async function selected() {
  const { InkController } = await import("@/ink/controller");
  const c = new InkController("nb", { kind: "lasso", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  const s = stroke("a", [100, 100, 200, 140], 4);
  rowsRef.rows.set("a", s);
  c.setSelection({ sectionId: "sec", ids: new Set(["a"]), box: { minX: 100, minY: 100, maxX: 200, maxY: 140 } });
  return c;
}

describe("lasso circle actions", () => {
  it("scales the selection about its centre, widths too, and undoes it", async () => {
    const c = await selected();
    await c.scaleSelection(2);
    const d = rowsRef.rows.get("a")!.data;
    expect([d.pts[0], d.pts[1], d.pts[6], d.pts[7]]).toEqual([50, 80, 250, 160]);
    expect(d.size).toBe(8);
    expect(c.selection?.box).toEqual({ minX: 50, minY: 80, maxX: 250, maxY: 160 });
    await c.undo.undo();
    expect(rowsRef.rows.get("a")!.data.size).toBe(4);
    expect(c.selection?.box).toEqual({ minX: 100, minY: 100, maxX: 200, maxY: 140 });
  });

  it("keeps a scaled selection on the page", async () => {
    const c = await selected();
    await c.scaleSelection(4);
    expect(c.selection!.box.minX).toBe(0);
    expect(c.selection!.box.minY).toBe(40);
  });

  it("recolours the selection and undoes it", async () => {
    const c = await selected();
    await c.recolorSelection("#dc2626");
    expect(rowsRef.rows.get("a")!.data.color).toBe("#dc2626");
    await c.undo.undo();
    expect(rowsRef.rows.get("a")!.data.color).toBe("#000");
  });
});
