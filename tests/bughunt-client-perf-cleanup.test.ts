import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StrokeEntity } from "@/lib/types";

// Detaching the live overlay (leaving the notebook) must cancel its queued frame and give the
// bitmap back: Safari keeps canvas memory until the canvas is resized.

vi.mock("@/ink/render", () => ({ strokePath: vi.fn(() => ({})), seedPath: vi.fn(), paintStroke: vi.fn(), cachedPath: vi.fn() }));
vi.mock("@/lib/store", () => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: "new", kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

let frames: FrameRequestCallback[] = [];
const cancelled: number[] = [];
beforeEach(() => {
  frames = [];
  cancelled.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (frames.push(cb), frames.length));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => cancelled.push(id));
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
});
afterEach(() => vi.unstubAllGlobals());

it("cancels the queued frame and releases the old bitmap when the overlay detaches", async () => {
  const { InkController } = await import("@/ink/controller");
  const c = new InkController("nb", { kind: "pen", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fill: vi.fn(), save() {}, restore() {}, translate() {}, scale() {} };
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  c.attachLive(canvas as unknown as HTMLCanvasElement);
  expect(canvas.width).toBe(200);

  const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
  const sec = { id: "sec", el, strokes: () => [] };
  const ev = (type: string, x: number) => ({ type, pointerType: "pen", button: 0, pointerId: 1, clientX: x, clientY: x, pressure: 0.5, timeStamp: x, preventDefault() {} }) as unknown as PointerEvent;
  c.down(ev("pointerdown", 1), sec);
  c.move(ev("pointermove", 5), sec);
  expect(frames.length).toBeGreaterThan(0);

  c.attachLive(null);
  expect(cancelled).toContain(frames.length);
  expect([canvas.width, canvas.height]).toEqual([0, 0]);
  expect(c.isDrawing()).toBe(false);

  // A frame that was already queued finds nothing to draw.
  ctx.clearRect.mockClear();
  frames.forEach((cb) => cb(0));
  expect(ctx.clearRect).not.toHaveBeenCalled();
});
