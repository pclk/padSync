import { describe, expect, it } from "vitest";
import { DEFAULT_RAIL, RAIL_ITEMS, moveItem, normalizeRail, setHidden, visibleItems } from "@/lib/rail-layout";

describe("rail layout", () => {
  it("fills in a missing or damaged stored layout", () => {
    expect(normalizeRail(undefined)).toEqual(DEFAULT_RAIL);
    const fixed = normalizeRail({ order: ["text", "bogus", "text", "pen"] as never, hidden: ["pen", "highlighter"], dock: "top" as never, align: "end" });
    expect(fixed.order.slice(0, 2)).toEqual(["text", "pen"]);
    expect([...fixed.order].sort()).toEqual([...RAIL_ITEMS].sort());
    // The pen can't be hidden.
    expect(fixed.hidden).toEqual(["highlighter"]);
    expect(fixed.dock).toBe("left");
    expect(fixed.align).toBe("end");
  });

  it("moves items one place and stops at the ends", () => {
    const up = moveItem(DEFAULT_RAIL, "highlighter", -1);
    expect(up.order.slice(0, 2)).toEqual(["highlighter", "pen"]);
    expect(moveItem(up, "highlighter", -1)).toBe(up);
    expect(moveItem(DEFAULT_RAIL, "prompts", 1)).toBe(DEFAULT_RAIL);
  });

  it("hides and shows items, never the pen", () => {
    const l = setHidden(setHidden(DEFAULT_RAIL, "highlighter", true), "text", true);
    expect(visibleItems(l)).not.toContain("highlighter");
    expect(visibleItems(l)).not.toContain("text");
    expect(visibleItems(setHidden(l, "text", false))).toContain("text");
    expect(setHidden(DEFAULT_RAIL, "pen", true)).toBe(DEFAULT_RAIL);
  });
});

describe("generous rail taps", () => {
  // Stand-in buttons: a 44 px column with 2 px gaps, as on the rail.
  const fake = (top: number, hidden = false) => ({ top, closest: () => (hidden ? {} : null), getBoundingClientRect: () => ({ left: 18, right: 62, top, bottom: top + 44 }) });
  const root = (buttons: ReturnType<typeof fake>[]) => ({ querySelectorAll: () => buttons }) as unknown as HTMLElement;

  it("sends a tap in a gap or just outside the rail to the closest button, within reach", async () => {
    const { nearestButton } = await import("@/components/Toolbar");
    const [a, b, hiddenOne] = [fake(100), fake(146), fake(192, true)];
    const r = root([a, b, hiddenOne]);
    expect(nearestButton(r, 40, 144.8)).toBe(a); // in the gap, nearer the top button
    expect(nearestButton(r, 40, 146.5)).toBe(b);
    expect(nearestButton(r, 6, 160)).toBe(b); // left of the rail, in its margin
    expect(nearestButton(r, 40, 200)).toBe(b); // over an invisible slot: skipped
    expect(nearestButton(r, 140, 120)).toBe(null); // too far away
  });
});

describe("circle toolbar", () => {
  const vp: [number, number] = [1024, 768];

  it("is an option, kept through normalising", () => {
    expect(DEFAULT_RAIL.style).toBe("bar");
    expect(normalizeRail({ style: "circle" }).style).toBe("circle");
    expect(normalizeRail({ style: "blob" as never }).style).toBe("bar");
  });

  it("fans the tools out away from the docked edge, over at most a half circle", async () => {
    const { fanAngles } = await import("@/lib/tool-circle");
    // Middle of the left edge: centred on pointing right, from straight up to straight down.
    expect(fanAngles(5, [44, 384], vp).map(Math.round)).toEqual([-90, -45, 0, 45, 90]);
    // Middle of the bottom: centred on pointing up.
    const up = fanAngles(3, [512, 700], vp);
    expect(up[1]).toBeCloseTo(-90);
    expect(up[2] - up[0]).toBeCloseTo(90);
    expect(fanAngles(1, [44, 384], vp)).toHaveLength(1);
  });

  it("picks the tool the finger moves towards, nothing in the dead zone or back towards the edge", async () => {
    const { fanAngles, pickByDirection, PICK_DEAD_ZONE } = await import("@/lib/tool-circle");
    const angles = fanAngles(5, [44, 384], vp); // up, up-right, right, down-right, down
    expect(pickByDirection(angles, 60, 0)).toBe(2);
    expect(pickByDirection(angles, 40, -45)).toBe(1);
    expect(pickByDirection(angles, 5, 80)).toBe(4);
    expect(pickByDirection(angles, PICK_DEAD_ZONE - 1, 0)).toBe(-1);
    expect(pickByDirection(angles, -60, 0)).toBe(-1);
  });

  it("reorders among tools only when asked, skipping the rest", () => {
    const isTool = (i: string) => !["colors", "sizes", "history"].includes(i);
    const l = { ...DEFAULT_RAIL, order: ["pen", "colors", "text", "sizes", "history"] as typeof DEFAULT_RAIL.order };
    expect(moveItem(l, "pen", 1, isTool as never).order).toEqual(["text", "colors", "pen", "sizes", "history"]);
    expect(moveItem(l, "text", 1, isTool as never)).toBe(l);
  });

  it("renders one circle instead of the bar", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Toolbar } = await import("@/components/Toolbar");
    const tool = { kind: "highlighter" as const, penColor: "#111827", penSize: 2.2, hlColor: "#facc15", hlSize: 14, eraserSize: 12 };
    const html = renderToStaticMarkup(
      createElement(Toolbar, { title: "t", tool, setTool() {}, canUndo: true, canRedo: false, onUndo() {}, onRedo() {}, zoom: 1, onZoomReset() {}, panelOpen: false, onTogglePanel() {}, rail: { ...DEFAULT_RAIL, style: "circle" } }),
    );
    expect(html).toContain('data-style="circle"');
    expect(html).toContain("data-tap-zone");
    expect(html).toContain('aria-label="Highlighter: hold and drag to change tool, tap for colours and sizes"');
    expect(html).not.toContain("tool-rail flex");
    expect(html).not.toContain('aria-label="Undo"');
  });
});
