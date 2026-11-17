import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getStroke } from "perfect-freehand";
import { describe, expect, it } from "vitest";
import { strokeOptions, strokeSvgPath, toInput } from "@/ink/render";
import { THUMB_HEIGHT, thumbnailStrokes } from "@/lib/thumbnail";
import { NotebookThumb, ThumbInk } from "@/components/NotebookThumb";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";

// Roadmap 8: library cards preview the first page. Ink is drawn as inline SVG from the editor's
// own outline code, so pen smoothing and options match what the editor paints.

const pts = (n: number, y0: number, pressure = (i: number) => 0.3 + 0.3 * Math.sin(i)) =>
  Array.from({ length: n }, (_, i) => [10 + i * 6, y0 + Math.sin(i / 3) * 8, pressure(i), 1.5, 0, i * 4]).flat();
const stroke = (id: string, data: Partial<StrokeData>, t0 = 0): StrokeEntity => ({
  id, kind: "stroke", notebookId: "nb", parentId: "s", hlc: "1", deleted: 0, dirty: 0,
  data: { tool: "pen", color: "#112233", size: 4, pts: pts(30, 100), t0, input: "pen", device: "d", ...data },
});

describe("stroke thumbnails", () => {
  it("traces the editor's outline, including smoothed Pencil pressure", () => {
    const data = stroke("a", {}).data;
    const outline = getStroke(toInput(data.pts, "pen"), strokeOptions(data, true));
    const d = strokeSvgPath(data);
    expect(d.startsWith(`M${Math.round(outline[0][0] * 10) / 10} ${Math.round(outline[0][1] * 10) / 10}`)).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.match(/Q/g)).toHaveLength(outline.length - 1);
    // The pen path differs from the raw-pressure outline: the filter is applied.
    const raw = getStroke(Array.from({ length: 30 }, (_, i) => [data.pts[i * STROKE_STRIDE], data.pts[i * STROKE_STRIDE + 1], data.pts[i * STROKE_STRIDE + 2]]), strokeOptions(data, true));
    expect(raw.length !== outline.length || raw.some(([x, y], i) => Math.abs(x - outline[i][0]) + Math.abs(y - outline[i][1]) > 0.1)).toBe(true);
  });

  it("draws a tap as a dot", () => {
    const d = strokeSvgPath(stroke("dot", { pts: [50, 60, 0.5, 1.5, 0, 0] }).data);
    expect(d).toMatch(/^M[\d.]+ 60a/);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("puts highlighters under pen ink, keeps time order and skips ink below the preview", () => {
    const out = thumbnailStrokes([
      stroke("pen2", {}, 2),
      stroke("hl", { tool: "highlighter", color: "#ffee00", size: 18 }, 3),
      stroke("pen1", {}, 1),
      stroke("below", { pts: pts(10, THUMB_HEIGHT + 50) }, 0),
      { ...stroke("gone", {}, 0), deleted: 1 },
    ]);
    expect(out.map((s) => s.id)).toEqual(["hl", "pen1", "pen2"]);
    expect(out[0]).toMatchObject({ highlighter: true, color: "#ffee00" });
  });

  it("renders the ink as an inline SVG over the top of the page", () => {
    const html = renderToStaticMarkup(createElement(ThumbInk, { strokes: thumbnailStrokes([stroke("a", {}), stroke("hl", { tool: "highlighter" })]) }));
    expect(html).toContain(`viewBox="0 0 1376 ${THUMB_HEIGHT}"`);
    expect(html).toContain('preserveAspectRatio="xMidYMin slice"');
    expect(html).toContain('fill="#112233"');
    expect(html).toContain("mix-blend-mode:multiply");
  });

  it("shows dot paper until a visible card has something to draw", () => {
    const html = renderToStaticMarkup(createElement(NotebookThumb, { notebookId: "nb", stamp: 1 }));
    expect(html).toContain('data-thumb="empty"');
    expect(html).toContain("radial-gradient");
  });
});
