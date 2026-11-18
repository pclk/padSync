import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { panelWidth } from "@/lib/layout-mode";
import { PAGE_WIDTH } from "@/lib/types";
import {
  DESKTOP_RAIL_INSET,
  MAX_ZOOM,
  MIN_ZOOM,
  PAGE_GUTTER,
  clampZoom,
  fitZoom,
  notebookInsets,
  pageLeft,
  parseZoom,
  regionWidth,
  stageMinWidth,
  stageWidth,
} from "@/lib/viewport";

const mac = (vw: number, mode: "drawing" | "chat" | null) =>
  notebookInsets({ isIpad: false, panelOpen: mode !== null, panelWidth: mode ? panelWidth(mode, vw) : 0 });

describe("zoom limits", () => {
  it("are 25% to 300%", () => {
    expect(MIN_ZOOM).toBe(0.25);
    expect(MAX_ZOOM).toBe(3);
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(0.25)).toBe(0.25);
    expect(clampZoom(0.3)).toBe(0.3);
    expect(clampZoom(9)).toBe(3);
  });
  it("never let a bad value through", () => {
    for (const z of [NaN, Infinity, -Infinity]) expect(clampZoom(z)).toBe(1);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-1)).toBe(MIN_ZOOM);
    expect(clampZoom(NaN, 0.5)).toBe(0.5);
  });
  it("restore a saved zoom clamped, and ignore anything that is not a zoom", () => {
    expect(parseZoom(0.1)).toBe(0.25);
    expect(parseZoom(0.6)).toBe(0.6);
    expect(parseZoom(12)).toBe(3);
    for (const v of [undefined, null, "0.5", NaN, 0, -2, {}]) expect(parseZoom(v)).toBeNull();
  });
  it("are the only ones the editor uses", () => {
    const src = readFileSync("src/components/NotebookEditor.tsx", "utf8");
    expect(src).not.toMatch(/MIN_ZOOM|MAX_ZOOM\s*=/);
    // Pinch, trackpad pinch, reset and fit all go through the shared clamp.
    expect(src).toMatch(/from "@\/lib\/viewport"/);
    expect(src.match(/clampZoom\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Mac layout beside the side panel", () => {
  it("keeps the rail and the panel out of the fit", () => {
    expect(mac(1440, null)).toEqual({ left: DESKTOP_RAIL_INSET, right: 0 });
    expect(mac(1440, "drawing")).toEqual({ left: DESKTOP_RAIL_INSET, right: 720 });
    expect(mac(1440, "chat")).toEqual({ left: DESKTOP_RAIL_INSET, right: 1080 });
    expect(regionWidth(1440, mac(1440, "drawing"))).toBe(1440 - 720 - DESKTOP_RAIL_INSET - 2 * PAGE_GUTTER);
  });
  it("fits drawing mode to the free half and chat mode down to the 25% floor", () => {
    expect(fitZoom(1440, mac(1440, "drawing"))).toBeCloseTo((720 - DESKTOP_RAIL_INSET - 32) / PAGE_WIDTH);
    expect(fitZoom(1440, mac(1440, "chat"))).toBe(MIN_ZOOM);
    expect(fitZoom(3000, mac(3000, null))).toBe(1);
    expect(fitZoom(200, mac(200, "chat"))).toBe(MIN_ZOOM);
  });
  it("no longer stops at the old 40% floor in chat mode on a MacBook", () => {
    for (const vw of [1280, 1440, 1470, 1512, 1728]) expect(fitZoom(vw, mac(vw, "chat"))).toBeLessThan(0.4);
  });
  it("centres a page that fits, with no sideways scroll", () => {
    const insets = mac(1440, "drawing");
    const z = fitZoom(1440, insets), px = PAGE_WIDTH * z;
    expect(stageWidth(1440, insets, px)).toBe(1440);
    const left = pageLeft(1440, insets, px);
    expect(left - insets.left).toBeCloseTo(1440 - insets.right - (left + px));
  });
  it("reaches every part of the page at any zoom and layout by scrolling", () => {
    for (const vw of [800, 1024, 1280, 1440, 1512, 1728, 2560])
      for (const mode of ["drawing", "chat", null] as const)
        for (const z of [MIN_ZOOM, 0.3, 0.5, 0.75, 1, 2, MAX_ZOOM]) {
          const insets = mac(vw, mode), px = PAGE_WIDTH * z;
          const stage = stageWidth(vw, insets, px), left = pageLeft(vw, insets, px);
          // The page's left edge shows at scrollX = 0 right of the rail; its right edge shows at the
          // furthest scroll left of the panel.
          expect(left).toBeGreaterThanOrEqual(insets.left + PAGE_GUTTER);
          const maxScroll = stage - vw;
          expect(left + px - maxScroll).toBeLessThanOrEqual(vw - insets.right - PAGE_GUTTER + 1);
          expect(stageMinWidth(insets, px)).toBeLessThanOrEqual(stage);
        }
  });
});

describe("iPad layout", () => {
  it("keeps the rail floating over the page and only clears the side panel", () => {
    expect(notebookInsets({ isIpad: true, panelOpen: false, panelWidth: 360 })).toEqual({ left: 0, right: 0 });
    expect(notebookInsets({ isIpad: true, panelOpen: true, panelWidth: 360 })).toEqual({ left: 0, right: 360 });
  });
  it("centres the page as before when it fits", () => {
    const insets = notebookInsets({ isIpad: true, panelOpen: false, panelWidth: 360 });
    expect(pageLeft(1376, insets, 1000)).toBe((1376 - 1000) / 2);
  });
});

describe("a toggled desktop sidebar (stage 2)", () => {
  it("takes the rail's place as the left inset, or none when hidden", () => {
    expect(notebookInsets({ isIpad: false, panelOpen: false, panelWidth: 0, toolInset: 240 }).left).toBe(240);
    expect(notebookInsets({ isIpad: false, panelOpen: false, panelWidth: 0, toolInset: 0 }).left).toBe(0);
    expect(fitZoom(1440, { left: 0, right: 720 })).toBeGreaterThan(fitZoom(1440, { left: 240, right: 720 }));
  });
});
