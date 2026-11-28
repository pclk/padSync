import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageEntity, StrokeEntity } from "@/lib/types";

// Resizing the selection by its handles, and cropping a picture to a dragged frame (src/ink/controller.ts).

const rows = vi.hoisted(() => new Map<string, unknown>());
const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (list: { id: string }[]) => {
    for (const r of list) rows.set(r.id, r);
    return list;
  }),
  newEntity: vi.fn(),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/ink/render", () => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: { entities: { bulkGet: async (ids: string[]) => ids.map((id) => rows.get(id)) } }, deviceId: () => "dev" }));
vi.mock("@/lib/page-images", async (orig) => ({ ...(await orig<typeof import("@/lib/page-images")>()), cropImage: vi.fn(async () => "data:image/png;base64,CUT") }));

const stroke = { id: "a", kind: "stroke", deleted: 0, data: { size: 4, t0: 1, pts: [100, 100, 0.5, 1, 0, 0, 300, 200, 0.5, 1, 0, 8] } } as unknown as StrokeEntity;
const picture = { id: "img", kind: "image", parentId: "sec", deleted: 0, data: { x: 100, y: 300, w: 200, h: 100, src: "data:image/png;base64,AA" } } as unknown as ImageEntity;
const el = { getBoundingClientRect: () => ({ left: 0, top: 0, height: 1000 }), setPointerCapture() {} } as unknown as HTMLElement;
const sec = { id: "sec", el, strokes: () => [stroke], images: () => [picture] };
const ev = (type: string, x: number, y: number, mods: { shiftKey?: boolean } = {}) =>
  ({ type, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 3, clientX: x, clientY: y, pressure: 0.5, timeStamp: 1, preventDefault() {}, ...mods }) as unknown as PointerEvent;

async function setup() {
  const { InkController } = await import("@/ink/controller");
  const c = new InkController("nb", { kind: "lasso", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  c.registerSection(sec);
  return c;
}

beforeEach(() => {
  rows.clear();
  rows.set("a", stroke);
  rows.set("img", picture);
  store.putEntities.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
});
afterEach(() => vi.unstubAllGlobals());

const pull = async (c: Awaited<ReturnType<typeof setup>>, handle: "se" | "e", from: [number, number], to: [number, number], mods = {}) => {
  c.grabHandle(ev("pointerdown", ...from), sec, el, handle);
  c.move(ev("pointermove", ...to, mods), sec);
  c.up(ev("pointerup", ...to));
  await vi.waitFor(() => expect(store.putEntities).toHaveBeenCalled());
};

describe("resize handles", () => {
  it("a corner scales the ink in proportion, line width too, from the opposite corner", async () => {
    const c = await setup();
    c.setSelection({ sectionId: "sec", ids: new Set(["a"]), box: { minX: 100, minY: 100, maxX: 300, maxY: 200 } });
    await pull(c, "se", [300, 200], [500, 210]);
    const s = rows.get("a") as StrokeEntity;
    expect(s.data.pts.slice(0, 2)).toEqual([100, 100]);
    expect(s.data.pts.slice(6, 8)).toEqual([500, 300]);
    expect(s.data.size).toBe(8);
  });

  it("a side stretches one way only, and Shift on a corner frees the proportions", async () => {
    const c = await setup();
    c.setSelection({ sectionId: "sec", ids: new Set(["img"]), box: { minX: 100, minY: 300, maxX: 300, maxY: 400 } });
    await pull(c, "e", [300, 350], [400, 999]);
    expect((rows.get("img") as ImageEntity).data).toMatchObject({ x: 100, y: 300, w: 300, h: 100 });
    store.putEntities.mockClear();
    c.setSelection({ sectionId: "sec", ids: new Set(["img"]), box: { minX: 100, minY: 300, maxX: 400, maxY: 400 } });
    await pull(c, "se", [400, 400], [400, 450], { shiftKey: true });
    expect((rows.get("img") as ImageEntity).data).toMatchObject({ x: 100, y: 300, w: 300, h: 150 });
  });

  it("stops at the page's right edge", async () => {
    const c = await setup();
    c.setSelection({ sectionId: "sec", ids: new Set(["img"]), box: { minX: 100, minY: 300, maxX: 300, maxY: 400 } });
    await pull(c, "e", [300, 350], [9000, 350]);
    const { PAGE_WIDTH } = await import("@/lib/types");
    const d = (rows.get("img") as ImageEntity).data;
    expect(d.x + d.w).toBeCloseTo(PAGE_WIDTH);
  });
});

describe("crop frame", () => {
  it("opens on the selected picture, whole, and crops to the frame given", async () => {
    const c = await setup();
    c.setSelection({ sectionId: "sec", ids: new Set(["a", "img"]), box: { minX: 100, minY: 100, maxX: 300, maxY: 400 } });
    const cand = c.cropCandidate();
    expect(cand?.row.id).toBe("img");
    expect(cand?.keep).toEqual({ minX: 100, minY: 300, maxX: 300, maxY: 400 });
    expect(await c.cropImageTo("sec", "img", { minX: 150, minY: 320, maxX: 250, maxY: 380 })).toBe(1);
    expect((rows.get("img") as ImageEntity).data).toEqual({ x: 150, y: 320, w: 100, h: 60, src: "data:image/png;base64,CUT" });
  });

  it("leaves the picture be when the frame is the whole of it", async () => {
    const c = await setup();
    expect(await c.cropImageTo("sec", "img", { minX: 100, minY: 300, maxX: 300, maxY: 400 })).toBe(0);
    expect(store.putEntities).not.toHaveBeenCalled();
  });
});
