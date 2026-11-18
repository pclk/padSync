import { describe, expect, it } from "vitest";
import { layoutReducer, panelWidth, nextTickDelay, type LayoutState } from "@/lib/layout-mode";
const initial: LayoutState = { mode: "auto", effective: "chat", lastActivityAt: 0, drawingSince: 0 };
describe("layout-mode reducer", () => {
  it("initializes from recent activity", () => {
    expect(layoutReducer(initial, { type: "init", now: 20000, lastActivityAt: 0 }).effective).toBe("chat");
    expect(layoutReducer(initial, { type: "init", now: 20000, lastActivityAt: 19000 }).effective).toBe("drawing");
  });
  it("switches on activity and idle at the boundary", () => {
    const s = layoutReducer(initial, { type: "activity", at: 20000 });
    expect(s.effective).toBe("drawing");
    expect(layoutReducer(s, { type: "tick", now: 34999, drawing: false }).effective).toBe("drawing");
    expect(layoutReducer(s, { type: "tick", now: 35000, drawing: false }).effective).toBe("chat");
    expect(layoutReducer(s, { type: "tick", now: 35000, drawing: true }).effective).toBe("drawing");
  });
  it("honors hysteresis and does not restart it on activity", () => {
    const s = layoutReducer(initial, { type: "activity", at: 20000 });
    expect(layoutReducer(s, { type: "activity", at: 21000 }).drawingSince).toBe(20000);
    expect(layoutReducer(s, { type: "tick", now: 23999, drawing: false }, 1000).effective).toBe("drawing");
    expect(layoutReducer(s, { type: "tick", now: 24000, drawing: false }, 1000).effective).toBe("chat");
  });
  it("holds both manual choices until auto", () => {
    for (const mode of ["drawing", "chat"] as const) {
      const s = layoutReducer(initial, { type: "setMode", mode, now: 20000 });
      expect(layoutReducer(s, { type: "activity", at: 21000 })).toBe(s);
      expect(layoutReducer(s, { type: "tick", now: 90000, drawing: false })).toBe(s);
      expect(layoutReducer(s, { type: "setMode", mode: "auto", now: 90000 }).effective).toBe("chat");
    }
  });
});
it("panelWidth splits the window 50/50 for drawing and 25/75 for chat", () => {
  expect(panelWidth("drawing", 1440)).toBe(720);
  expect(panelWidth("chat", 1440)).toBe(1080);
  expect(panelWidth("drawing", 901)).toBe(451);
  expect(panelWidth("chat", 800)).toBe(600);
});
it("nextTickDelay returns only the remaining deadline", () => {
  expect(nextTickDelay(initial, 0)).toBeNull();
  const s = layoutReducer(initial, { type: "activity", at: 20000 });
  expect(nextTickDelay(s, 21000)).toBe(14000);
  expect(nextTickDelay(s, 21000, 1000)).toBe(3000);
  expect(nextTickDelay(s, 40000)).toBe(0);
  expect(nextTickDelay({ ...s, mode: "drawing" }, 21000)).toBeNull();
});
