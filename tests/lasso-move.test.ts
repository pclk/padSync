import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_WIDTH, type StrokeEntity } from "@/lib/types";

// Lassoed strokes can be dragged around the page by pressing anywhere in the selection box with
// the Pencil, a mouse or a finger; the move stays within the page.

const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `s${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/ink/render", () => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

const stroke = { id: "a", kind: "stroke", data: { pts: [100, 100, 0.5, 1, 0, 0, 140, 120, 0.5, 1, 0, 8] } } as unknown as StrokeEntity;
const el = { getBoundingClientRect: () => ({ left: 0, top: 0, height: 600 }), setPointerCapture() {} } as unknown as HTMLElement;
const sec = { id: "sec", el, strokes: () => [stroke] };
const box = { minX: 100, minY: 100, maxX: 140, maxY: 120 };
const ev = (type: string, x: number, y: number, pointerType = "touch") =>
  ({ type, pointerType, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, clientX: x, clientY: y, pressure: 0.5, timeStamp: 1, preventDefault() {} }) as unknown as PointerEvent;

async function setup() {
  const { InkController } = await import("@/ink/controller");
  const onDragging = vi.fn();
  const c = new InkController("nb", { kind: "lasso", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging, onTextCreate() {} });
  c.setSelection({ sectionId: "sec", ids: new Set(["a"]), box });
  return { c, onDragging };
}

beforeEach(() => {
  store.moveStrokes.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
});
afterEach(() => vi.unstubAllGlobals());

describe("moving a lasso selection", () => {
  it("a finger press on the box drags the selected strokes", async () => {
    const { c, onDragging } = await setup();
    const target = { setPointerCapture: vi.fn() } as unknown as Element;
    c.grab(ev("pointerdown", 110, 110), sec, target);
    expect(onDragging).toHaveBeenCalledWith(new Set(["a"]));
    c.move(ev("pointermove", 150, 210), sec);
    c.up(ev("pointerup", 150, 210));
    await vi.waitFor(() => expect(store.moveStrokes).toHaveBeenCalledWith([stroke], 40, 100));
    expect(c.selection?.box).toEqual({ minX: 140, minY: 200, maxX: 180, maxY: 220 });
    expect(c.isDrawing()).toBe(false);
  });

  it("a finger elsewhere on the page still does not draw", async () => {
    const { c } = await setup();
    c.down(ev("pointerdown", 400, 400), sec);
    expect(c.isDrawing()).toBe(false);
  });

  it("keeps the selection on the page", async () => {
    const { c } = await setup();
    c.grab(ev("pointerdown", 110, 110, "pen"), sec, { setPointerCapture() {} } as unknown as Element);
    c.move(ev("pointermove", -500, 5000, "pen"), sec);
    c.up(ev("pointerup", -500, 5000, "pen"));
    await vi.waitFor(() => expect(store.moveStrokes).toHaveBeenCalledWith([stroke], -100, 480));
  });

  it("ignores a press when nothing is selected in that section", async () => {
    const { c, onDragging } = await setup();
    c.grab(ev("pointerdown", 110, 110), { ...sec, id: "other" }, { setPointerCapture() {} } as unknown as Element);
    expect(onDragging).not.toHaveBeenCalled();
    expect(c.isDrawing()).toBe(false);
  });
});

describe("clampMove", () => {
  it("allows moves inside the page and stops at its edges", async () => {
    const { clampMove } = await import("@/ink/controller");
    expect(clampMove(box, 10, 10, 600)).toEqual([10, 10]);
    expect(clampMove(box, PAGE_WIDTH, -1000, 600)).toEqual([PAGE_WIDTH - 140, -100]);
  });

  it("lets a box already past an edge move back in but not further out", async () => {
    const { clampMove } = await import("@/ink/controller");
    const out = { minX: -5, minY: 10, maxX: 20, maxY: 30 };
    expect(clampMove(out, -10, 0, 600)).toEqual([0, 0]);
    expect(clampMove(out, 10, 0, 600)).toEqual([10, 0]);
  });
});

describe("duplicating a lasso selection", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    store.setDeleted.mockClear();
    store.logEvent.mockClear();
  });

  it("copies the strokes a little down and right, leaves the originals, and selects the copy", async () => {
    const { c } = await setup();
    await c.duplicateSelection(sec);
    const [copies] = store.putEntities.mock.calls[0] as unknown as [StrokeEntity[]];
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe("a");
    expect(copies[0].parentId).toBe("sec");
    expect(copies[0].data.pts).toEqual([124, 124, 0.5, 1, 0, 0, 164, 144, 0.5, 1, 0, 8]);
    expect(stroke.data.pts[0]).toBe(100);
    expect(c.selection?.ids).toEqual(new Set([copies[0].id]));
    expect(c.selection?.box).toEqual({ minX: 124, minY: 124, maxX: 164, maxY: 144 });
  });

  it("keeps the copy on the page at the bottom-right edge", async () => {
    const { c } = await setup();
    const corner = { minX: PAGE_WIDTH - 40, minY: 560, maxX: PAGE_WIDTH, maxY: 590 };
    c.setSelection({ sectionId: "sec", ids: new Set(["a"]), box: corner });
    await c.duplicateSelection(sec);
    expect(c.selection?.box).toEqual({ ...corner, minY: 570, maxY: 600 });
  });

  it("undo removes the copy and clears its selection; redo brings it back", async () => {
    const { c } = await setup();
    await c.duplicateSelection(sec);
    const id = [...c.selection!.ids][0];
    await c.undo.undo();
    expect(store.setDeleted).toHaveBeenLastCalledWith([id], true);
    expect(c.selection).toBeNull();
    await c.undo.redo();
    expect(store.setDeleted).toHaveBeenLastCalledWith([id], false);
  });

  it("does nothing for another section's handle", async () => {
    const { c } = await setup();
    await c.duplicateSelection({ ...sec, id: "other" });
    expect(store.putEntities).not.toHaveBeenCalled();
  });
});
