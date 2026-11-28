import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageEntity, StrokeEntity } from "@/lib/types";

// The rectangle lasso, Copy and paste, and which images Crop applies to (src/ink/controller.ts).

const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: unknown[]) => rows),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `n${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/ink/render", () => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

const stroke = { id: "a", kind: "stroke", data: { t0: 1, pts: [100, 100, 0.5, 1, 0, 0, 140, 120, 0.5, 1, 0, 8] } } as unknown as StrokeEntity;
const picture = { id: "img", kind: "image", data: { x: 300, y: 300, w: 200, h: 100, src: "data:image/png;base64,AA" } } as unknown as ImageEntity;
const el = { getBoundingClientRect: () => ({ left: 0, top: 0, height: 1000 }), setPointerCapture() {} } as unknown as HTMLElement;
const sec = { id: "sec", el, strokes: () => [stroke], images: () => [picture] };
const ev = (type: string, x: number, y: number) =>
  ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 3, clientX: x, clientY: y, pressure: 0.5, timeStamp: 1, preventDefault() {} }) as unknown as PointerEvent;

async function setup() {
  const { InkController } = await import("@/ink/controller");
  const c = new InkController("nb", { kind: "lasso", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  c.registerSection(sec);
  return { c, InkController };
}
const drag = (c: Awaited<ReturnType<typeof setup>>["c"], from: [number, number], to: [number, number]) => {
  c.down(ev("pointerdown", ...from), sec);
  c.move(ev("pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2), sec);
  c.move(ev("pointermove", ...to), sec);
  c.up(ev("pointerup", ...to));
};

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
});
afterEach(() => vi.unstubAllGlobals());

describe("rectangle lasso", () => {
  it("selects an empty area as a rectangle", async () => {
    const { c } = await setup();
    c.setLassoShape("rect");
    drag(c, [600, 600], [700, 650]);
    expect(c.selection?.ids.size).toBe(0);
    expect(c.selection?.area).toEqual({ minX: 600, minY: 600, maxX: 700, maxY: 650 });
  });

  it("picks the ink and images inside, and offers Crop for an image reaching outside", async () => {
    const { c } = await setup();
    c.setLassoShape("rect");
    drag(c, [90, 90], [400, 380]);
    expect([...c.selection!.ids].sort()).toEqual(["a", "img"]);
    expect(c.croppable().map((x) => x.keep)).toEqual([{ minX: 300, minY: 300, maxX: 400, maxY: 380 }]);
  });
});

describe("free lasso", () => {
  it("keeps the box around the loop for Copy image", async () => {
    const { c } = await setup();
    c.down(ev("pointerdown", 80, 80), sec);
    for (const [x, y] of [[200, 80], [200, 200], [80, 200]]) c.move(ev("pointermove", x, y), sec);
    c.up(ev("pointerup", 80, 200));
    expect([...c.selection!.ids]).toEqual(["a"]);
    expect(c.selection?.bounds).toEqual({ minX: 80, minY: 80, maxX: 200, maxY: 200 });
  });
});

describe("copy and paste", () => {
  it("pastes copies centred where asked, selected", async () => {
    const { c, InkController } = await setup();
    c.setSelection({ sectionId: "sec", ids: new Set(["a", "img"]), box: { minX: 100, minY: 100, maxX: 500, maxY: 400 } });
    expect(c.copySelection()).toBe(true);
    expect(InkController.clipboard?.images).toHaveLength(1);
    store.putEntities.mockClear();
    await c.pasteClip(sec, 800, 900);
    const rows = store.putEntities.mock.calls[0][0] as { kind: string; data: { x?: number; y?: number; pts?: number[] } }[];
    expect(rows.find((r) => r.kind === "image")?.data).toMatchObject({ x: 800, y: 950 });
    expect(rows.find((r) => r.kind === "stroke")?.data.pts?.slice(0, 2)).toEqual([600, 750]);
    expect(c.selection?.box).toEqual({ minX: 600, minY: 750, maxX: 1000, maxY: 1050 });
  });
});
