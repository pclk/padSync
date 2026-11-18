import { describe, expect, it } from "vitest";
import { pdfDensity } from "@/components/PdfBackground";
import { rasterScale } from "@/lib/pdf";

// Zoomed out, PDF pages decode at a fraction of full density so many pages in view fit in memory.

describe("pdfDensity", () => {
  it("drops to half density at 50% zoom and below", () => {
    expect(pdfDensity(0.4, 2)).toBe(1);
    expect(pdfDensity(0.5, 2)).toBe(1);
  });
  it("uses three quarters between 50% and 75%", () => {
    expect(pdfDensity(0.6, 2)).toBe(1.5);
  });
  it("is the full screen density from 75% up", () => {
    expect(pdfDensity(1, 2)).toBe(2);
    expect(pdfDensity(3, 2)).toBe(2);
  });
  it("still covers the pixels the page shows on screen", () => {
    for (const zoom of [0.4, 0.5, 0.6, 0.75, 1, 2]) expect(rasterScale({ height: 1780 }, pdfDensity(zoom, 2))).toBeGreaterThanOrEqual(Math.min(2 * zoom, 2));
  });
});
