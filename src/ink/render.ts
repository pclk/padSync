import { getStroke, type StrokeOptions } from "perfect-freehand";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";

// Stroke geometry lives in section-local coordinates (1 unit = 1 CSS px at zoom 1).
// The outline polygon is computed once per (id, hlc) and cached as a Path2D.

export function strokeOptions(d: Pick<StrokeData, "tool" | "size" | "input">, last: boolean): StrokeOptions {
  if (d.tool === "highlighter") {
    return { size: d.size, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last, start: { cap: false }, end: { cap: false } };
  }
  return {
    size: d.size,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.32,
    simulatePressure: d.input !== "pen",
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last,
  };
}

export function toInput(pts: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i += STROKE_STRIDE) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  const n = outline.length;
  if (n < 2) return path;
  // Quadratic curves through midpoints give a smooth closed outline.
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function strokePath(d: StrokeData, last = true): Path2D {
  if (d.pts.length === STROKE_STRIDE) {
    // A tap: draw a dot.
    const p = new Path2D();
    const r = d.tool === "highlighter" ? d.size / 2 : (d.size * (0.35 + 0.5 * (d.input === "pen" ? d.pts[2] : 0.5))) / 2;
    p.arc(d.pts[0], d.pts[1], Math.max(r, 0.8), 0, Math.PI * 2);
    return p;
  }
  return outlineToPath(getStroke(toInput(d.pts), strokeOptions(d, last)));
}

const pathCache = new Map<string, Path2D>();

export function cachedPath(s: StrokeEntity): Path2D {
  const key = `${s.id}:${s.hlc}`;
  let p = pathCache.get(key);
  if (!p) {
    p = strokePath(s.data);
    if (pathCache.size > 20000) pathCache.clear();
    pathCache.set(key, p);
  }
  return p;
}

export function paintStroke(ctx: CanvasRenderingContext2D, d: StrokeData, path: Path2D) {
  if (d.tool === "highlighter") {
    ctx.globalAlpha = 0.32;
    ctx.globalCompositeOperation = "multiply";
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.fillStyle = d.color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/** Draws highlighter strokes first so pen ink stays crisp on top. */
export function paintStrokes(ctx: CanvasRenderingContext2D, strokes: StrokeEntity[], offset?: { ids: Set<string>; dx: number; dy: number }) {
  const ordered = [...strokes].sort((a, b) => (a.data.tool === b.data.tool ? a.data.t0 - b.data.t0 : a.data.tool === "highlighter" ? -1 : 1));
  for (const s of ordered) {
    const moved = offset?.ids.has(s.id);
    if (moved) {
      ctx.save();
      ctx.translate(offset!.dx, offset!.dy);
    }
    paintStroke(ctx, s.data, cachedPath(s));
    if (moved) ctx.restore();
  }
}
