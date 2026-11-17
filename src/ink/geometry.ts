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
  // Tap rendering enforces a 0.8px minimum radius, even for very fine pens.
  const pad = Math.max(d.size, d.pts.length === STROKE_STRIDE ? 0.8 : 0);
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
  const dx = bx - ax, dy = by - ay;
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
      const nx = i + STROKE_STRIDE < p.length ? p[i + STROKE_STRIDE] : p[i];
      const ny = i + STROKE_STRIDE < p.length ? p[i + STROKE_STRIDE + 1] : p[i + 1];
      const sx = nx - p[i], sy = ny - p[i + 1];
      const cross = dx * sy - dy * sx;
      const qx = p[i] - ax, qy = p[i + 1] - ay;
      const t = (qx * sy - qy * sx) / cross;
      const u = (qx * dy - qy * dx) / cross;
      hit = (cross !== 0 && t >= 0 && t <= 1 && u >= 0 && u <= 1)
        || distToSegmentSq(ax, ay, p[i], p[i + 1], nx, ny) <= r2
        || distToSegmentSq(bx, by, p[i], p[i + 1], nx, ny) <= r2
        || distToSegmentSq(p[i], p[i + 1], ax, ay, bx, by) <= r2
        || distToSegmentSq(nx, ny, ax, ay, bx, by) <= r2;
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
