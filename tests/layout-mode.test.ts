import { describe, expect, it } from "vitest";
import { isLayoutMode, panelWidth } from "@/lib/layout-mode";
describe("layout-mode", () => {
  it("panelWidth hides the panel for drawing, splits 50/50 for half and 25/75 for chat", () => {
    expect(panelWidth("drawing", 1440)).toBe(0);
    expect(panelWidth("drawing", 500, 200)).toBe(0);
    expect(panelWidth("half", 1440)).toBe(720);
    // Chat gives way just enough to keep a whole 25% page beside it.
    expect(panelWidth("chat", 1440)).toBe(1064);
    expect(panelWidth("chat", 2560)).toBe(1920);
    expect(panelWidth("half", 901)).toBe(451);
    // A window this narrow keeps a whole 25% page beside chat (see notebook-viewport tests).
    expect(panelWidth("chat", 800)).toBe(424);
  });
  it("rejects modes this version doesn't know, such as the old auto", () => {
    expect(isLayoutMode("auto")).toBe(false);
    expect(["drawing", "half", "chat"].every(isLayoutMode)).toBe(true);
  });
});
