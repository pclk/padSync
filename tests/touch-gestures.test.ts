import { describe, expect, it } from "vitest";
import {
  DEFAULT_GESTURES,
  DOUBLE_MS,
  GestureRecognizer,
  HOLD_MS,
  PENCIL_QUIET_MS,
  TAP_MS,
  normalizeGestures,
  type GestureBindings,
  type GestureKind,
  type TouchPoint,
} from "@/lib/touch-gestures";

// A recognizer on a fake clock: timers run when the clock passes them.
function setup(bindings: Partial<GestureBindings> = {}) {
  const b = { ...DEFAULT_GESTURES, ...bindings };
  const fired: GestureKind[] = [];
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 0;
  const r = new GestureRecognizer(
    (g) => fired.push(g),
    (g) => b[g] !== "none",
    {
      set: (fn, ms) => {
        timers.push({ at: now + ms, fn, id: ++next });
        return next;
      },
      clear: (id) => (timers = timers.filter((t) => t.id !== id)),
    },
  );
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers = timers.filter((x) => x !== t);
      t.fn();
    }
  };
  const fingers = (n: number, x = 100, y = 100): TouchPoint[] => Array.from({ length: n }, (_, i) => ({ id: i, x: x + i * 50, y }));
  /** n fingers down, held `ms`, lifted. */
  const tap = (n: number, { ms = 80, onPage = true, x = 100 } = {}) => {
    r.start(fingers(n, x), now, onPage);
    advance(ms);
    r.end([], now);
  };
  return { r, fired, advance, tap, fingers, now: () => now };
}

describe("touch gestures", () => {
  it("keeps two-finger tap undo and three-finger tap redo by default", () => {
    const { fired, tap, advance } = setup();
    tap(2);
    advance(50);
    tap(3);
    expect(fired).toEqual(["twoTap", "threeTap"]);
  });

  it("reads four-finger taps", () => {
    const { fired, tap } = setup({ fourTap: "tool:eraser" });
    tap(4);
    expect(fired).toEqual(["fourTap"]);
  });

  it("is not a tap when held too long or when the fingers move (a pan or pinch)", () => {
    const { r, fired, tap, fingers } = setup();
    tap(2, { ms: TAP_MS + 20 });
    r.start(fingers(2), 0, true);
    r.move(fingers(2, 140));
    r.end([], 50);
    expect(fired).toEqual([]);
  });

  it("waits to tell a two-finger double tap from a single only when the double is assigned", () => {
    const { fired, tap, advance } = setup({ twoDoubleTap: "previousTool" });
    tap(2);
    expect(fired).toEqual([]);
    advance(100);
    tap(2);
    expect(fired).toEqual(["twoDoubleTap"]);
    tap(2);
    advance(DOUBLE_MS + 10);
    expect(fired).toEqual(["twoDoubleTap", "twoTap"]);
  });

  it("reads a finger double tap on the page, not on the controls", () => {
    const { fired, tap, advance } = setup({ fingerDoubleTap: "tool:lasso" });
    tap(1);
    advance(100);
    tap(1);
    expect(fired).toEqual(["fingerDoubleTap"]);
    advance(500);
    tap(1, { onPage: false });
    advance(100);
    tap(1, { onPage: false });
    expect(fired).toEqual(["fingerDoubleTap"]);
  });

  it("needs both taps of a double in the same place", () => {
    const { fired, tap, advance } = setup({ fingerDoubleTap: "undo" });
    tap(1);
    advance(100);
    tap(1, { x: 400 });
    expect(fired).toEqual([]);
  });

  it("reads a finger held still, once, and not if it moves", () => {
    const { r, fired, advance, fingers, now } = setup({ fingerHold: "togglePanel" });
    r.start(fingers(1), now(), true);
    advance(HOLD_MS + 10);
    r.end([], now());
    expect(fired).toEqual(["fingerHold"]);
    r.start(fingers(1), now(), true);
    r.move(fingers(1, 130));
    advance(HOLD_MS + 10);
    r.end([], now());
    expect(fired).toEqual(["fingerHold"]);
  });

  it("ignores one-finger gestures just after the Pencil, so a resting palm does nothing", () => {
    const { r, fired, tap, advance, fingers, now } = setup({ fingerHold: "undo", fingerDoubleTap: "redo" });
    r.pencil(now());
    advance(100);
    r.start(fingers(1), now(), true);
    advance(HOLD_MS + 10);
    r.end([], now());
    tap(1);
    advance(50);
    tap(1);
    expect(fired).toEqual([]);
    advance(PENCIL_QUIET_MS);
    tap(1);
    advance(50);
    tap(1);
    expect(fired).toEqual(["fingerDoubleTap"]);
  });

  it("counts nothing when the system cancels the touches", () => {
    const { r, fired, fingers } = setup();
    r.start(fingers(4), 0, true);
    r.cancel();
    r.end([], 50);
    expect(fired).toEqual([]);
  });

  it("fills in stored bindings and drops unknown actions", () => {
    expect(normalizeGestures(undefined)).toEqual(DEFAULT_GESTURES);
    const n = normalizeGestures({ twoTap: "tool:eraser", threeTap: "explode" as never });
    expect(n.twoTap).toBe("tool:eraser");
    expect(n.threeTap).toBe("redo");
  });
});
