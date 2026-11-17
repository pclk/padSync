import { strokeSvgPath } from "@/ink/render";
import { PAGE_WIDTH, STROKE_STRIDE, type StrokeEntity } from "./types";

// Library card previews: the top of a notebook's first page, in page units. Nothing here is
// stored or synced; it is recomputed from local rows when a card scrolls into view.

/** Card previews are 16:10, so they show the top PAGE_WIDTH × THUMB_HEIGHT of the first page. */
export const THUMB_HEIGHT = Math.round((PAGE_WIDTH * 10) / 16);

export interface ThumbStroke { id: string; d: string; color: string; highlighter: boolean }

/**
 * SVG outlines for the strokes visible in a thumbnail, built with the editor's renderer (same
 * pressure smoothing and pen options), highlighters first like paintStrokes. Strokes entirely
 * below the preview are skipped without computing an outline.
 */
export function thumbnailStrokes(strokes: StrokeEntity[], height = THUMB_HEIGHT): ThumbStroke[] {
  const ordered = strokes
    .filter((s) => !s.deleted && minY(s.data.pts) - s.data.size < height)
    .sort((a, b) => (a.data.tool === b.data.tool ? a.data.t0 - b.data.t0 : a.data.tool === "highlighter" ? -1 : 1));
  const out: ThumbStroke[] = [];
  for (const s of ordered) {
    const d = strokeSvgPath(s.data);
    if (d) out.push({ id: s.id, d, color: s.data.color, highlighter: s.data.tool === "highlighter" });
  }
  return out;
}

function minY(pts: number[]) {
  let y = Infinity;
  for (let i = 1; i < pts.length; i += STROKE_STRIDE) if (pts[i] < y) y = pts[i];
  return y;
}
