import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxCache = new Map<string, Box>();

export function strokeBox(s: StrokeEntity): Box {
  const key = `${s.id}:${s.hlc}`;
  let b = boxCache.get(key);
  if (!b) {
    b = dataBox(s.data);
    if (boxCache.size > 20000) boxCache.clear();
    boxCache.set(key, b);
  }
  return b;
}

export function dataBox(d: StrokeData): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < d.pts.length; i += STROKE_STRIDE) {
    const x = d.pts[i], y = d.pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = d.size;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Strokes touched by an eraser segment from (ax,ay) to (bx,by) with the given radius. */
export function hitStrokes(strokes: StrokeEntity[], ax: number, ay: number, bx: number, by: number, radius: number): StrokeEntity[] {
  const hits: StrokeEntity[] = [];
  const sMinX = Math.min(ax, bx) - radius, sMaxX = Math.max(ax, bx) + radius;
  const sMinY = Math.min(ay, by) - radius, sMaxY = Math.max(ay, by) + radius;
  for (const s of strokes) {
    const b = strokeBox(s);
    if (b.maxX < sMinX || b.minX > sMaxX || b.maxY < sMinY || b.minY > sMaxY) continue;
    const r = radius + s.data.size / 2;
    const r2 = r * r;
    const p = s.data.pts;
    let hit = false;
    for (let i = 0; i < p.length && !hit; i += STROKE_STRIDE) {
      // Sample the eraser path at a few points against each stroke point.
      for (let k = 0; k <= 4 && !hit; k++) {
        const ex = ax + ((bx - ax) * k) / 4, ey = ay + ((by - ay) * k) / 4;
        const nx = i + STROKE_STRIDE < p.length ? p[i + STROKE_STRIDE] : p[i];
        const ny = i + STROKE_STRIDE < p.length ? p[i + STROKE_STRIDE + 1] : p[i + 1];
        if (distToSegmentSq(ex, ey, p[i], p[i + 1], nx, ny) <= r2) hit = true;
      }
    }
    if (hit) hits.push(s);
  }
  return hits;
}

export function pointInPolygon(x: number, y: number, poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A stroke is lassoed when at least half of its points fall inside the polygon. */
export function lassoStrokes(strokes: StrokeEntity[], poly: number[][]): StrokeEntity[] {
  if (poly.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return strokes.filter((s) => {
    // Strokes clear of the lasso's bounds can't have points inside it.
    const b = strokeBox(s);
    if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) return false;
    const p = s.data.pts;
    let inside = 0, total = 0;
    for (let i = 0; i < p.length; i += STROKE_STRIDE) {
      total++;
      if (pointInPolygon(p[i], p[i + 1], poly)) inside++;
    }
    return total > 0 && inside / total >= 0.5;
  });
}
