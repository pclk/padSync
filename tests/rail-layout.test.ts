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
    expect(moveItem(DEFAULT_RAIL, "history", 1)).toBe(DEFAULT_RAIL);
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
