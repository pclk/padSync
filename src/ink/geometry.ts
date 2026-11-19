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

/** Page units between the lasso points kept for testing. */
const LASSO_STEP = 2;
/** The most points of one stroke tested against the lasso. */
const SAMPLES = 24;

/**
 * An inside test for a closed loop, precomputed as scanlines one page unit apart: where the loop
 * crosses each row, so a point costs a row lookup and a binary search instead of a pass over
 * every edge. Exact to within a page unit vertically, which a finger-drawn lasso can't tell apart.
 */
function loopTester(poly: number[][], minY: number, maxY: number) {
  const rows: Float64Array[] = [];
  const h = Math.ceil(maxY - minY) + 1;
  for (let r = 0; r < h; r++) {
    const y = minY + r + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    rows.push(Float64Array.from(xs).sort());
  }
  return (x: number, y: number) => {
    const row = rows[Math.floor(y - minY)];
    if (!row) return false;
    // Inside when an odd number of crossings lie to the left.
    let lo = 0, hi = row.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (row[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return (lo & 1) === 1;
  };
}

/** `path` with points closer than `step` to the last kept one dropped; the last point always kept. */
export function thinPath(path: number[][], step: number): number[][] {
  if (path.length < 3) return path;
  const out = [path[0]];
  const s2 = step * step;
  for (let i = 1; i < path.length - 1; i++) {
    const [x, y] = path[i];
    const [px, py] = out[out.length - 1];
    if ((x - px) ** 2 + (y - py) ** 2 >= s2) out.push(path[i]);
  }
  out.push(path[path.length - 1]);
  return out;
}

/**
 * How a lasso picks strokes: "touch" takes any stroke it reaches (a point inside, or its line
 * running over the stroke's ink); "enclose" only those with at least half their points inside.
 */
export type LassoMode = "touch" | "enclose";

/** The strokes a lasso drawn along `poly` (closed back to its start) selects. */
export function lassoStrokes(strokes: StrokeEntity[], drawn: number[][], mode: LassoMode = "enclose"): StrokeEntity[] {
  // Every sample tests against every edge, so a long lasso (hundreds of touch samples) made lifting
  // slow on a full page. Points closer than this to the last kept one change nothing visible.
  const poly = thinPath(drawn, LASSO_STEP);
  if (poly.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const inLoop = loopTester(poly, minY, maxY);
  // Each edge's bounds, so the line test skips edges nowhere near a stroke.
  const edges: Box[] = [];
  for (let k = 1; k < poly.length; k++) {
    const [ax, ay] = poly[k - 1], [bx, by] = poly[k];
    edges.push({ minX: Math.min(ax, bx), minY: Math.min(ay, by), maxX: Math.max(ax, bx), maxY: Math.max(ay, by) });
  }
  return strokes.filter((s) => {
    // Strokes clear of the lasso's bounds (and, touching, its line's reach) can't be picked.
    const b = strokeBox(s);
    const reach = mode === "touch" ? s.data.size / 2 : 0;
    if (b.maxX < minX - reach || b.minX > maxX + reach || b.maxY < minY - reach || b.minY > maxY + reach) return false;
    // At most SAMPLES points, evenly spaced: enough for the inside share, and a stroke only partly
    // inside is caught by the line test anyway. Long strokes no longer cost a test per sample.
    const p = s.data.pts;
    const n = p.length / STROKE_STRIDE;
    const every = Math.max(1, Math.floor(n / SAMPLES));
    let inside = 0, total = 0;
    for (let j = 0; j < n; j += every) {
      const i = j * STROKE_STRIDE;
      total++;
      if (inLoop(p[i], p[i + 1])) {
        if (mode === "touch") return true;
        inside++;
      }
    }
    if (mode === "enclose") return total > 0 && inside / total >= 0.5;
    // The line as drawn (not the closing edge back to the start) crossing or grazing the ink.
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      if (e.maxX < b.minX - reach || e.minX > b.maxX + reach || e.maxY < b.minY - reach || e.minY > b.maxY + reach) continue;
      if (hitStrokes([s], poly[k][0], poly[k][1], poly[k + 1][0], poly[k + 1][1], 0).length) return true;
    }
    return false;
  });
}
