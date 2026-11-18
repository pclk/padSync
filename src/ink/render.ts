import { getStroke, type StrokeOptions } from "perfect-freehand";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";
import { dropBacktracks, smoothPositions, smoothPressure } from "./filters";
import { penFeel } from "./pen-feel";

// Stroke geometry lives in section-local coordinates (1 unit = 1 CSS px at zoom 1).
// The outline polygon is computed once per (id, hlc) and cached as a Path2D.

export function strokeOptions(d: Pick<StrokeData, "tool" | "size" | "input" | "smoothing" | "sensitivity">, last: boolean): StrokeOptions {
  if (d.tool === "highlighter") {
    return { size: d.size, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last, start: { cap: false }, end: { cap: false } };
  }
  if (d.input === "pen") {
    // Pencil pressure arrives smoothed (smoothPressure). Linear easing makes `size` the line width
    // at mid pressure; the old sine easing drew pen lines ~1.4× the chosen size.
    return { size: d.size, ...penFeel(d.smoothing, d.sensitivity), simulatePressure: false, easing: (t) => t, last };
  }
  // Mouse and trackpad keep their simulated pressure; only the smoothness setting applies.
  const feel = d.smoothing === undefined ? { streamline: 0.32, smoothing: 0.5 } : penFeel(d.smoothing);
  return {
    size: d.size,
    thinning: 0.55,
    smoothing: feel.smoothing,
    streamline: feel.streamline,
    simulatePressure: true,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last,
  };
}

/**
 * perfect-freehand input. Pencil input is cleaned here, at render time, never in storage:
 * pressure is smoothed, re-sent samples that step backwards are dropped (dropBacktracks) and
 * positions are lightly smoothed along the stroke (smoothPositions).
 */
export function toInput(pts: number[], input?: string): number[][] {
  const pen = input === "pen";
  const pressure = pen ? smoothPressure(pts) : null;
  const out: number[][] = [];
  const times: number[] = [];
  for (let i = 0, j = 0; i < pts.length; i += STROKE_STRIDE, j++) {
    out.push([pts[i], pts[i + 1], pressure ? pressure[j] : pts[i + 2]]);
    times.push(pts[i + 5]);
  }
  return pen ? smoothPositions(dropBacktracks(out, times)) : out;
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

/** Radius of a single-point stroke (a tap), drawn as a dot. */
export function dotRadius(d: StrokeData): number {
  const r = d.tool === "highlighter" ? d.size / 2 : (d.size * (0.35 + 0.5 * (d.input === "pen" ? smoothPressure(d.pts)[0] : 0.5))) / 2;
  return Math.max(r, 0.8);
}

export function strokePath(d: StrokeData, last = true): Path2D {
  if (d.pts.length === STROKE_STRIDE) {
    // A tap: draw a dot.
    const p = new Path2D();
    p.arc(d.pts[0], d.pts[1], dotRadius(d), 0, Math.PI * 2);
    return p;
  }
  return outlineToPath(getStroke(toInput(d.pts, d.input), strokeOptions(d, last)));
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The same outline as strokePath, as an SVG path `d` (for library thumbnails, no canvas needed). */
export function strokeSvgPath(d: StrokeData): string {
  if (d.pts.length === STROKE_STRIDE) {
    const [x, y, r] = [d.pts[0], d.pts[1], dotRadius(d)].map(r1);
    return `M${r1(x - r)} ${y}a${r} ${r} 0 1 0 ${r1(2 * r)} 0a${r} ${r} 0 1 0 ${r1(-2 * r)} 0Z`;
  }
  const outline = getStroke(toInput(d.pts, d.input), strokeOptions(d, true));
  const n = outline.length;
  if (n < 2) return "";
  // Quadratic curves through midpoints, exactly as outlineToPath.
  let out = `M${r1(outline[0][0])} ${r1(outline[0][1])}`;
  for (let i = 1; i < n; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % n];
    out += `Q${r1(x0)} ${r1(y0)} ${r1((x0 + x1) / 2)} ${r1((y0 + y1) / 2)}`;
  }
  return out + "Z";
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

/** Hands the cache an outline already computed for this exact version (e.g. at commit). */
export function seedPath(s: Pick<StrokeEntity, "id" | "hlc">, path: Path2D) {
  if (pathCache.size > 20000) pathCache.clear();
  pathCache.set(`${s.id}:${s.hlc}`, path);
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
