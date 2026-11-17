import type { StrokeEntity } from "@/lib/types";
import { strokeBox } from "./geometry";

// Committed ink is painted into fixed-height tiles. Writing a stroke should cost one tile one
// stroke of painting, not every tile a full repaint, so:
// - sameVersions lets a tile skip re-rendering (and its paint effect) when its strokes did not
//   change, even though every query returns fresh objects;
// - paintDelta tells a tile when the new set is the old one plus pen strokes on top, which can
//   be painted over the existing bitmap.

export const TILE_H = 768;

export interface TilePlan {
  top: number;
  h: number;
  strokes: StrokeEntity[];
}

const version = (s: StrokeEntity) => `${s.id}:${s.hlc}`;

export function sameVersions(a: StrokeEntity[], b: StrokeEntity[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].hlc !== b[i].hlc) return false;
  return true;
}

export function planTiles(height: number, strokes: StrokeEntity[]): TilePlan[] {
  const n = Math.max(1, Math.ceil(height / TILE_H));
  const out: TilePlan[] = [];
  for (let i = 0; i < n; i++) {
    const top = i * TILE_H;
    const h = Math.min(TILE_H, height - top);
    const inTile = strokes.filter((s) => {
      const b = strokeBox(s);
      return b.maxY >= top && b.minY <= top + h;
    });
    out.push({ top, h, strokes: inTile });
  }
  return out;
}

/**
 * Strokes to paint over a bitmap that already shows `painted` so it ends up showing `next`, or
 * null when it has to be repainted from scratch. Painting order is highlighters, then pens, each
 * by t0 (see paintStrokes), so only pens newer than every painted pen can go on top.
 */
export function paintDelta(painted: StrokeEntity[], next: StrokeEntity[]): StrokeEntity[] | null {
  if (next.length < painted.length) return null;
  const have = new Set(painted.map(version));
  let lastPen = -Infinity;
  for (const s of painted) if (s.data.tool !== "highlighter" && s.data.t0 > lastPen) lastPen = s.data.t0;
  const added: StrokeEntity[] = [];
  let kept = 0;
  for (const s of next) {
    if (have.has(version(s))) {
      kept++;
      continue;
    }
    if (s.data.tool === "highlighter" || s.data.t0 <= lastPen) return null;
    added.push(s);
  }
  return kept === painted.length ? added : null;
}
