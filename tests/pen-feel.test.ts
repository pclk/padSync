import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getStroke } from "perfect-freehand";
import { DEFAULT_SENSITIVITY, DEFAULT_SMOOTHING, penFeel } from "@/ink/pen-feel";
import { strokeOptions, toInput } from "@/ink/render";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";

// Pen feel: adjustable smoothness and pressure sensitivity, stored on each stroke.

const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `s${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));

const line = (pressure: number, n = 40): number[] => {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(i * 3, 50, pressure, 1.2, 0, i * 4);
  return pts;
};

/** Vertical extent of the outline across the middle of a horizontal line: the drawn width. */
function midWidth(d: StrokeData): number {
  const outline = getStroke(toInput(d.pts, d.input), strokeOptions(d, true));
  const mid = d.pts[(d.pts.length / STROKE_STRIDE / 2) * STROKE_STRIDE];
  const ys = outline.filter(([x]) => Math.abs(x - mid) < 4).map(([, y]) => y);
  return Math.max(...ys) - Math.min(...ys);
}

const pen = (extra: Partial<StrokeData> = {}): StrokeData => ({ tool: "pen", color: "#000", size: 3.4, pts: line(0.5), t0: 0, input: "pen", device: "d", ...extra });

describe("penFeel", () => {
  it("more smoothness means more streamline and smoothing; values are clamped", () => {
    const lo = penFeel(0, DEFAULT_SENSITIVITY);
    const hi = penFeel(1, DEFAULT_SENSITIVITY);
    expect(hi.streamline).toBeGreaterThan(lo.streamline);
    expect(hi.smoothing).toBeGreaterThan(lo.smoothing);
    expect(penFeel(-3, 9)).toEqual(penFeel(0, 1));
  });

  it("zero sensitivity gives an even width", () => {
    expect(penFeel(DEFAULT_SMOOTHING, 0).thinning).toBe(0);
  });
});

describe("pen strokes", () => {
  it("draw at the chosen size at mid pressure (not ~1.4× it)", () => {
    expect(midWidth(pen())).toBeCloseTo(3.4, 0);
  });

  it("use the feel stored on the stroke, with defaults for older strokes", () => {
    const options = ({ streamline, smoothing, thinning }: ReturnType<typeof penFeel>) => ({ streamline, smoothing, thinning });
    expect(strokeOptions(pen({ smoothing: 1, sensitivity: 0 }), true)).toMatchObject(options(penFeel(1, 0)));
    expect(strokeOptions(pen(), true)).toMatchObject(options(penFeel()));
  });

  it("low sensitivity keeps width steady when pressure changes", () => {
    const light = (s: number) => midWidth(pen({ pts: line(0.2), sensitivity: s }));
    const hard = (s: number) => midWidth(pen({ pts: line(0.9), sensitivity: s }));
    expect(Math.abs(hard(0) - light(0))).toBeLessThan(0.01);
    expect(hard(1) - light(1)).toBeGreaterThan(hard(DEFAULT_SENSITIVITY) - light(DEFAULT_SENSITIVITY));
  });

  it("mouse strokes keep their old options unless a smoothness was stored", () => {
    const mouse = pen({ input: "mouse" });
    expect(strokeOptions(mouse, true)).toMatchObject({ streamline: 0.32, smoothing: 0.5, simulatePressure: true });
    expect(strokeOptions({ ...mouse, smoothing: 1 }, true).streamline).toBe(penFeel(1).streamline);
  });
});

describe("controller", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} quadraticCurveTo() {} arc() {} closePath() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stamps new pen strokes with the tool's feel, and highlighter strokes without it", async () => {
    const { InkController } = await import("@/ink/controller");
    const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20, penSmoothing: 0.8, penSensitivity: 0.1 };
    const c = new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
    const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
    const sec = { id: "sec", el, strokes: () => [] };
    const ev = (type: string, x: number) =>
      ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, clientX: x, clientY: x, pressure: 0.5, timeStamp: x * 20, preventDefault() {} }) as unknown as PointerEvent;
    const draw = () => {
      c.down(ev("pointerdown", 1), sec);
      c.move(ev("pointermove", 20), sec);
      c.up(ev("pointerup", 40));
    };
    draw();
    c.configure({ ...tool, kind: "highlighter" }, 1);
    draw();
    await vi.waitFor(() => expect(store.putEntities).toHaveBeenCalledTimes(2));
    const [penData, hlData] = store.putEntities.mock.calls.map(([rows]) => rows[0].data as StrokeData);
    expect(penData).toMatchObject({ smoothing: 0.8, sensitivity: 0.1 });
    expect(hlData.smoothing).toBeUndefined();
    expect(hlData.sensitivity).toBeUndefined();
  });
});

describe("PenSettings", () => {
  it("renders the two sliders and a preview stroke", async () => {
    const { PenSettings } = await import("@/components/PenSettings");
    const tool = { kind: "pen" as const, penColor: "#111827", penSize: 3.4, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
    const html = renderToStaticMarkup(createElement(PenSettings, { tool, setTool() {}, anchorY: 200, onClose() {} }));
    expect(html).toContain('aria-label="Pen settings"');
    expect(html).toContain('aria-label="Smoothness"');
    expect(html).toContain('aria-label="Pressure"');
    expect(html).toMatch(/<path d="M[^"]{50,}"/);
  });
});
