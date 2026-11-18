import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { getStroke } from "perfect-freehand";
import { DEFAULT_PEN, PEN_GROUPS, legacyOverrides, penOverrides, pressureOf, setPressure, setSmoothness, smoothnessOf, strokePen, withOverrides } from "@/ink/pen-feel";
import { strokeOptions, toInput } from "@/ink/render";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";

// Pen feel: every pen parameter is adjustable; strokes store the ones that differ from the defaults.

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
  const outline = getStroke(toInput(d.pts, d.input, strokePen(d)), strokeOptions(d, true));
  const mid = d.pts[(d.pts.length / STROKE_STRIDE / 2) * STROKE_STRIDE];
  const ys = outline.filter(([x]) => Math.abs(x - mid) < 4).map(([, y]) => y);
  return Math.max(...ys) - Math.min(...ys);
}

const pen = (extra: Partial<StrokeData> = {}): StrokeData => ({ tool: "pen", color: "#000", size: 3.4, pts: line(0.5), t0: 0, input: "pen", device: "d", ...extra });

describe("pen parameters", () => {
  it("the quick sliders at their old defaults give the default parameters", () => {
    expect(setPressure(setSmoothness(DEFAULT_PEN, 0.5), 0.4)).toEqual(DEFAULT_PEN);
    expect(smoothnessOf(DEFAULT_PEN)).toBeCloseTo(0.5);
    expect(pressureOf(DEFAULT_PEN)).toBeCloseTo(0.4);
  });

  it("more smoothness means more streamline, outline and path smoothing", () => {
    const lo = setSmoothness(DEFAULT_PEN, 0);
    const hi = setSmoothness(DEFAULT_PEN, 1);
    expect(hi.streamline).toBeGreaterThan(lo.streamline);
    expect(hi.smoothing).toBeGreaterThan(lo.smoothing);
    expect(hi.positionSigma).toBeGreaterThan(lo.positionSigma);
    expect(setPressure(DEFAULT_PEN, 0).thinning).toBe(0);
  });

  it("every parameter has a control, and every default is within its range", () => {
    const keys = PEN_GROUPS.flatMap((g) => g.params.map((p) => p.key));
    expect(new Set(keys)).toEqual(new Set(Object.keys(DEFAULT_PEN)));
    expect(keys).toHaveLength(Object.keys(DEFAULT_PEN).length);
    for (const spec of PEN_GROUPS.flatMap((g) => g.params)) {
      if (spec.kind !== "range") continue;
      expect(DEFAULT_PEN[spec.key]).toBeGreaterThanOrEqual(spec.min);
      expect(DEFAULT_PEN[spec.key]).toBeLessThanOrEqual(spec.max);
    }
  });

  it("stores only changed parameters, and ignores or clamps bad synced values", () => {
    expect(penOverrides(DEFAULT_PEN)).toEqual({});
    expect(penOverrides({ ...DEFAULT_PEN, taperEnd: 12 })).toEqual({ taperEnd: 12 });
    const p = withOverrides({ maxPointGap: 0, streamline: "x", easing: "wobbly", capEnd: false, unknown: 3 });
    expect(p.maxPointGap).toBe(0.5);
    expect(p.streamline).toBe(DEFAULT_PEN.streamline);
    expect(p.easing).toBe(DEFAULT_PEN.easing);
    expect(p.capEnd).toBe(false);
  });

  it("older strokes and tool state keep their quick feel", () => {
    expect(strokePen({ smoothing: 1, sensitivity: 0 })).toEqual(setPressure(setSmoothness(DEFAULT_PEN, 1), 0));
    expect(strokePen({})).toEqual(DEFAULT_PEN);
    expect(legacyOverrides(0.5, 0.4)).toEqual({});
    expect(withOverrides(legacyOverrides(0.8, 0.1))).toEqual(setPressure(setSmoothness(DEFAULT_PEN, 0.8), 0.1));
  });
});

describe("pen strokes", () => {
  it("draw at the chosen size at mid pressure (not ~1.4× it)", () => {
    expect(midWidth(pen())).toBeCloseTo(3.4, 0);
  });

  it("use the parameters stored on the stroke", () => {
    expect(strokeOptions(pen({ pen: { streamline: 0.9, thinning: -0.5, taperStart: 10, capEnd: false } }), true)).toMatchObject({
      streamline: 0.9,
      thinning: -0.5,
      start: { taper: 10, cap: true },
      end: { taper: 0, cap: false },
    });
    expect(strokeOptions(pen(), true)).toMatchObject({ streamline: DEFAULT_PEN.streamline, thinning: DEFAULT_PEN.thinning });
  });

  it("sine easing draws thicker than linear", () => {
    expect(midWidth(pen({ pen: { easing: "sine" } }))).toBeGreaterThan(midWidth(pen()) * 1.3);
  });

  it("low thinning keeps width steady when pressure changes", () => {
    const width = (pressure: number, thinning: number) => midWidth(pen({ pts: line(pressure), pen: { thinning } }));
    expect(Math.abs(width(0.9, 0) - width(0.2, 0))).toBeLessThan(0.01);
    expect(width(0.9, 0.75) - width(0.2, 0.75)).toBeGreaterThan(width(0.9, 0.3) - width(0.2, 0.3));
  });

  it("mouse strokes keep their old options unless the stroke stored a feel", () => {
    const mouse = pen({ input: "mouse" });
    expect(strokeOptions(mouse, true)).toMatchObject({ streamline: 0.32, smoothing: 0.5, simulatePressure: true });
    expect(strokeOptions({ ...mouse, pen: { streamline: 0.8 } }, true).streamline).toBe(0.8);
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

  it("stamps new pen strokes with the tool's changed parameters, and highlighter strokes without them", async () => {
    const { InkController } = await import("@/ink/controller");
    const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20, pen: { streamline: 0.8, taperEnd: 20 } };
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
    expect(penData.pen).toEqual({ streamline: 0.8, taperEnd: 20 });
    expect(hlData.pen).toBeUndefined();
  });
});

describe("capture settings", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} quadraticCurveTo() {} arc() {} closePath() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} } as unknown as HTMLElement;
  const sec = { id: "sec", el, strokes: () => [] };
  const ev = (type: string, x: number, t: number, pressure = 0.5) =>
    ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, clientX: x, clientY: 10, pressure, timeStamp: t, preventDefault() {} }) as unknown as PointerEvent;
  const controller = async (pen: Record<string, unknown>) => {
    const { InkController } = await import("@/ink/controller");
    return new InkController("nb", { kind: "pen", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20, pen }, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  };

  it("the stray-dot thresholds decide whether a quick light tap is kept", async () => {
    for (const [pen, kept] of [[{}, 0], [{ dotMinMs: 0 }, 1]] as const) {
      store.putEntities.mockClear();
      const c = await controller(pen);
      c.down(ev("pointerdown", 5, 100, 0.05), sec);
      c.up(ev("pointerup", 5, 110, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(store.putEntities).toHaveBeenCalledTimes(kept);
    }
  });

  it("out-of-order samples are kept when that filter is off", async () => {
    const c = await controller({ dropOutOfOrder: false });
    c.down(ev("pointerdown", 0, 100), sec);
    c.move(ev("pointermove", 8, 108), sec);
    c.move(ev("pointermove", 4, 104), sec);
    c.up(ev("pointerup", 12, 112));
    await vi.waitFor(() => expect(store.putEntities).toHaveBeenCalledTimes(1));
    const xs = (store.putEntities.mock.calls[0][0][0].data as StrokeData).pts.filter((_, i) => i % 6 === 0);
    expect(xs).toEqual([0, 8, 4, 12]);
  });
});

describe("PenSettings", () => {
  it("renders the quick sliders, every parameter and a preview stroke", async () => {
    const { PenSettings } = await import("@/components/PenSettings");
    const tool = { kind: "pen" as const, penColor: "#111827", penSize: 3.4, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
    const html = renderToStaticMarkup(createElement(PenSettings, { tool, setTool() {}, anchorY: 200, onClose() {} }));
    expect(html).toContain('aria-label="Pen settings"');
    expect(html).toContain('aria-label="Smoothness"');
    expect(html).toContain('aria-label="Pressure"');
    for (const spec of PEN_GROUPS.flatMap((g) => g.params)) expect(html).toContain(`aria-label="${spec.label}"`);
    expect(html).toMatch(/<path d="M[^"]{50,}"/);
  });
});
