import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StrokeData, StrokeEntity } from "@/lib/types";

// Roadmap 0a: the Pencil must never stay dead after a lost pointerup/pointercancel. Any of a new
// pointerdown, lostpointercapture, a hover move, a hidden page or an unmount ends the gesture.

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

const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
const sec = { id: "sec", el, strokes: () => [] };
const ev = (type: string, pointerId: number, x: number, extra: Record<string, unknown> = {}) =>
  ({ type, pointerType: "pen", button: 0, buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0, pointerId, clientX: x, clientY: x, pressure: 0.5, timeStamp: x, preventDefault() {}, ...extra }) as unknown as PointerEvent;
const committed = () => store.putEntities.mock.calls.map(([rows]) => (rows[0].data as StrokeData).pts.length / 6);

async function setup() {
  const { InkController } = await import("@/ink/controller");
  return new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
}

beforeEach(() => {
  store.putEntities.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
});
afterEach(() => vi.unstubAllGlobals());

describe("pencil never stays frozen", () => {
  it("a new pointerdown after a lost pointerup commits the stale stroke and starts a new one", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.move(ev("pointermove", 1, 5), sec);
    // pointerup for pointer 1 never arrives.
    c.down(ev("pointerdown", 2, 20), sec);
    expect(c.isDrawing()).toBe(true);
    c.move(ev("pointermove", 2, 25), sec);
    c.move(ev("pointermove", 2, 30), sec);
    c.up(ev("pointerup", 2, 30));
    expect(c.isDrawing()).toBe(false);
    expect(committed()).toEqual([2, 3]);
  });

  it("a repeated pointerdown with the same pointerId also recovers", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.down(ev("pointerdown", 1, 40), sec);
    c.up(ev("pointerup", 1, 40));
    expect(committed()).toEqual([1, 1]);
    expect(c.isDrawing()).toBe(false);
  });

  it("pointercancel mid-stroke keeps what was drawn and frees the pencil", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.move(ev("pointermove", 1, 5), sec);
    c.up(ev("pointercancel", 1, 99));
    expect(c.isDrawing()).toBe(false);
    expect(committed()).toEqual([2]);
    c.down(ev("pointerdown", 2, 10), sec);
    expect(c.isDrawing()).toBe(true);
  });

  it("lostpointercapture ends the gesture; the later pointerup is harmless", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.move(ev("pointermove", 1, 5), sec);
    c.lostCapture(ev("lostpointercapture", 1, 5), sec);
    expect(c.isDrawing()).toBe(false);
    c.up(ev("pointerup", 1, 7));
    expect(committed()).toEqual([2]);
  });

  it("ignores lostpointercapture for another pointer", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.lostCapture(ev("lostpointercapture", 9, 5), sec);
    expect(c.isDrawing()).toBe(true);
  });

  it("a hover move (no buttons) from the drawing pointer ends a stroke whose pointerup was lost", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.move(ev("pointermove", 1, 5), sec);
    c.move(ev("pointermove", 1, 50, { buttons: 0 }), sec);
    expect(c.isDrawing()).toBe(false);
    expect(committed()).toEqual([2]);
  });

  it("endGesture (page hidden, blur, section unmount) frees the pencil, scoped by section", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    c.endGesture("other-section");
    expect(c.isDrawing()).toBe(true);
    c.endGesture("sec");
    expect(c.isDrawing()).toBe(false);
    c.down(ev("pointerdown", 2, 1), sec);
    c.endGesture();
    expect(c.isDrawing()).toBe(false);
    expect(committed()).toEqual([1, 1]);
  });

  it("still draws when setPointerCapture throws for a pointer WebKit already dropped", async () => {
    const c = await setup();
    const throwing = { ...sec, el: { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() { throw new DOMException("gone", "NotFoundError"); } } as unknown as HTMLElement };
    expect(() => c.down(ev("pointerdown", 1, 1), throwing)).not.toThrow();
    expect(c.isDrawing()).toBe(true);
  });

  it("reports inking so background sync waits for the stroke", async () => {
    const { isInking } = await import("@/lib/activity");
    const c = await setup();
    c.down(ev("pointerdown", 1, 1), sec);
    expect(isInking()).toBe(true);
    c.up(ev("pointerup", 1, 2));
    expect(isInking()).toBe(false);
  });
});
