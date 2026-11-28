import type { Box } from "./geometry";

// Resizing a box by one of its eight handles, as in Figma: a corner moves two edges, a side one.
// The selection's resize (controller.ts) and the image crop frame (CropFrame.tsx) share it.

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const isCorner = (h: Handle) => h.length === 2;
export const HANDLE_CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
/** Where a handle sits on the box, as fractions of its width and height. */
export const HANDLE_AT: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

export interface ResizeOptions {
  /** Keep the box's proportions (a side handle then grows the other way about the centre too). */
  keepRatio?: boolean;
  /** Grow about the box's centre instead of the opposite edge. */
  fromCentre?: boolean;
  /** The smallest width and height. */
  min?: number;
  /** The box may not grow past these edges (a box already past one may stay there). */
  within?: Box;
}

/**
 * `b` resized by dragging `handle` by (dx, dy). It never flips over: past the opposite edge it
 * stops at `min`.
 */
export function resizeBox(b: Box, handle: Handle, dx: number, dy: number, o: ResizeOptions = {}): Box {
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const min = o.min ?? 1;
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const both = o.fromCentre ? 2 : 1;
  // What each side may grow to before it leaves `within`, given what stays put.
  const room = (lo: number, hi: number, wlo: number, whi: number, s: number, size: number) => {
    const r = o.fromCentre || s === 0 ? 2 * Math.min((lo + hi) / 2 - wlo, whi - (lo + hi) / 2) : s > 0 ? whi - lo : hi - wlo;
    return Math.max(r, size);
  };
  const maxW = o.within ? room(b.minX, b.maxX, o.within.minX, o.within.maxX, sx, w) : Infinity;
  const maxH = o.within ? room(b.minY, b.maxY, o.within.minY, o.within.maxY, sy, h) : Infinity;
  let nw = sx ? w + sx * dx * both : w;
  let nh = sy ? h + sy * dy * both : h;
  if (o.keepRatio && w > 0 && h > 0) {
    // The axis dragged further sets the scale; a side handle sets it alone.
    const kx = nw / w, ky = nh / h;
    let k = !sy ? kx : !sx ? ky : Math.abs(kx - 1) >= Math.abs(ky - 1) ? kx : ky;
    k = Math.min(Math.max(k, min / w, min / h), maxW / w, maxH / h);
    nw = w * k;
    nh = h * k;
  } else {
    nw = Math.min(Math.max(nw, Math.min(min, w)), maxW);
    nh = Math.min(Math.max(nh, Math.min(min, h)), maxH);
  }
  // A side handle with the ratio kept grows the other axis about its centre.
  const place = (lo: number, hi: number, size: number, s: number) =>
    o.fromCentre || s === 0 ? [(lo + hi) / 2 - size / 2, (lo + hi) / 2 + size / 2] : s > 0 ? [lo, lo + size] : [hi - size, hi];
  const [minX, maxX] = place(b.minX, b.maxX, nw, sx);
  const [minY, maxY] = place(b.minY, b.maxY, nh, sy);
  return { minX, minY, maxX, maxY };
}

/** `b` moved by (dx, dy), kept inside `within`. */
export function moveBoxWithin(b: Box, dx: number, dy: number, within: Box): Box {
  const mx = Math.min(Math.max(dx, within.minX - b.minX), within.maxX - b.maxX);
  const my = Math.min(Math.max(dy, within.minY - b.minY), within.maxY - b.maxY);
  return { minX: b.minX + mx, maxX: b.maxX + mx, minY: b.minY + my, maxY: b.maxY + my };
}

/** The scale and offset taking `from` onto `to`: x' = x * kx + ox, y' = y * ky + oy. */
export function boxMap(from: Box, to: Box) {
  const kx = from.maxX > from.minX ? (to.maxX - to.minX) / (from.maxX - from.minX) : 1;
  const ky = from.maxY > from.minY ? (to.maxY - to.minY) / (from.maxY - from.minY) : 1;
  return { kx, ky, ox: to.minX - from.minX * kx, oy: to.minY - from.minY * ky };
}

export function mapBox(b: Box, m: ReturnType<typeof boxMap>): Box {
  return { minX: b.minX * m.kx + m.ox, maxX: b.maxX * m.kx + m.ox, minY: b.minY * m.ky + m.oy, maxY: b.maxY * m.ky + m.oy };
}
