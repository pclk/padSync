import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOT_MIN_MS, DOT_MIN_PRESSURE, PRESSURE_FALLBACK, PRESSURE_MAX_STEP, isStrayDot, smoothPressure } from "@/ink/filters";
import type { StrokeData, StrokeEntity } from "@/lib/types";

// Roadmap 0b: Pencil pressure is smoothed at render time (stored points stay raw), and bounces,
// resting tips and cancelled Scribble touches are not committed as dots.

const pts = (pressures: number[], dx = 2) => pressures.flatMap((p, i) => [i * dx, 0, p, 1.5, 0, i * 4]);

describe("smoothPressure", () => {
  it("holds the first real pressure over near-zero touchdown samples and the 0 of pointerup", () => {
    const out = smoothPressure(pts([0, 0.01, 0.4, 0.4, 0.4, 0]));
    expect(out[0]).toBeCloseTo(0.4);
    expect(out[1]).toBeCloseTo(0.4);
    expect(out[5]).toBeCloseTo(0.4);
  });

  it("damps sample-to-sample noise and limits each step", () => {
    const noisy = [0.4, 0.6, 0.2, 0.6, 0.2, 0.6, 0.2, 0.6];
    const out = smoothPressure(pts(noisy));
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(PRESSURE_MAX_STEP + 1e-9);
    expect(Math.max(...out) - Math.min(...out)).toBeLessThan(0.05);
  });

  it("follows a sustained press", () => {
    const out = smoothPressure(pts([0.2, ...Array(60).fill(0.7)]));
    expect(out[out.length - 1]).toBeGreaterThan(0.65);
  });

  it("is causal, so a live prefix renders the same widths as the committed stroke", () => {
    const raw = [0, 0.3, 0.5, 0.35, 0.6, 0.45, 0.2, 0.5, 0];
    const full = smoothPressure(pts(raw));
    expect(smoothPressure(pts(raw.slice(0, 5)))).toEqual(full.slice(0, 5));
  });

  it("falls back when a stroke never leaves the floor", () => {
    expect(smoothPressure(pts([0, 0.01, 0]))).toEqual([PRESSURE_FALLBACK, PRESSURE_FALLBACK, PRESSURE_FALLBACK]);
  });
});

describe("isStrayDot", () => {
  const dot = (p: number[], input = "pen") => ({ pts: pts(p, 0.2), input });

  it("drops a brief, light touch with no length (bounce, resting tip, Scribble)", () => {
    expect(isStrayDot(dot([0.02, 0.05]), { durationMs: 12, maxPressure: 0.08 })).toBe(true);
  });

  it("keeps a dot that is held a little", () => {
    expect(isStrayDot(dot([0.05, 0.1]), { durationMs: DOT_MIN_MS + 30, maxPressure: 0.1 })).toBe(false);
  });

  it("keeps a quick dot placed with real pressure", () => {
    expect(isStrayDot(dot([0.3]), { durationMs: 15, maxPressure: DOT_MIN_PRESSURE + 0.1 })).toBe(false);
  });

  it("keeps anything with length, however quick", () => {
    expect(isStrayDot({ pts: pts([0.05, 0.05, 0.05], 2), input: "pen" }, { durationMs: 10, maxPressure: 0.05 })).toBe(false);
  });

  it("never drops mouse clicks", () => {
    expect(isStrayDot(dot([0.5], "mouse"), { durationMs: 0, maxPressure: 0 })).toBe(false);
  });
});

// The controller applies the dot filter with the real contact time and peak pressure.
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
const ev = (type: string, t: number, pressure: number, x = 10) =>
  ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, clientX: x, clientY: 10, pressure, timeStamp: t, preventDefault() {} }) as unknown as PointerEvent;
const committed = () => store.putEntities.mock.calls.map(([rows]) => rows[0].data as StrokeData);

describe("controller dot filter", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 100, innerHeight: 100 });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const { InkController } = await import("@/ink/controller");
    return new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
  }

  it("does not commit a Pencil bounce", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 100, 0.02), sec);
    c.up(ev("pointerup", 110, 0));
    expect(committed()).toEqual([]);
  });

  it("commits a held i-dot even though its repeated points were not stored", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 100, 0.05), sec);
    c.move(ev("pointermove", 140, 0.12), sec);
    c.up(ev("pointerup", 190, 0));
    const [d] = committed();
    expect(d.pts.length).toBe(6);
    // Stored data stays raw.
    expect(d.pts[2]).toBe(0.05);
  });

  it("commits a quick dot placed with pressure", async () => {
    const c = await setup();
    c.down(ev("pointerdown", 100, 0.35), sec);
    c.up(ev("pointerup", 115, 0));
    expect(committed().length).toBe(1);
  });
});
