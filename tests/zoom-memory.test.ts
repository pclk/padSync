import { describe, expect, it } from "vitest";
import { pdfDensity } from "@/components/PdfBackground";
import { rasterScale } from "@/lib/pdf";
import { MAX_TILE_SCALE, TILE_H, tileScale } from "@/ink/tiles";
import { PAGE_WIDTH } from "@/lib/types";

// Zoomed out, PDF pages decode at a fraction of full density so many pages in view fit in memory.

describe("pdfDensity", () => {
  it("drops to half density at 50% zoom and below", () => {
    expect(pdfDensity(0.4, 2)).toBe(1);
    expect(pdfDensity(0.5, 2)).toBe(1);
  });
  it("follows the zoom in quarter steps between 50% and 100%", () => {
    expect(pdfDensity(0.6, 2)).toBe(1.25);
    expect(pdfDensity(0.8, 2)).toBe(1.75);
  });
  it("is the full screen density from 100% up", () => {
    expect(pdfDensity(1, 2)).toBe(2);
    expect(pdfDensity(3, 2)).toBe(2);
  });
  it("keeps the old tiers with the quarterSteps flag off", () => {
    expect(pdfDensity(0.6, 2, false)).toBe(1.5);
    expect(pdfDensity(0.8, 2, false)).toBe(2);
    expect(pdfDensity(0.4, 2, false)).toBe(1);
  });
  it("still covers the pixels the page shows on screen", () => {
    for (const zoom of [0.4, 0.5, 0.6, 0.75, 1, 2]) expect(rasterScale({ height: 1780 }, pdfDensity(zoom, 2))).toBeGreaterThanOrEqual(Math.min(2 * zoom, 2));
  });
});

describe("tileScale", () => {
  it("follows the zoom in quarter steps on a 2x iPad", () => {
    expect(tileScale(0.25, 2)).toBe(0.5);
    expect(tileScale(0.8, 2)).toBe(1.75);
    expect(tileScale(1, 2)).toBe(2);
    expect(tileScale(1.1, 2)).toBe(2.25);
  });
  it("never draws below what the screen shows, up to the cap", () => {
    for (const zoom of [0.25, 0.33, 0.6, 0.9, 1.2, 1.45]) expect(tileScale(zoom, 2)).toBeGreaterThanOrEqual(2 * zoom);
  });
  it("caps from about 148% up, so a full-width tile stays under 4096 px", () => {
    expect(tileScale(1.5, 2)).toBe(MAX_TILE_SCALE);
    expect(tileScale(3, 2)).toBe(MAX_TILE_SCALE);
    expect(PAGE_WIDTH * MAX_TILE_SCALE).toBeLessThan(4096);
    // One tile at the cap: about 37 MB of bitmap.
    expect((PAGE_WIDTH * MAX_TILE_SCALE * TILE_H * MAX_TILE_SCALE * 4) / 1e6).toBeLessThan(38);
  });
  it("keeps half steps with the quarterSteps flag off", () => {
    expect(tileScale(0.8, 2, false)).toBe(2);
    expect(tileScale(0.6, 2, false)).toBe(1.5);
  });
});
