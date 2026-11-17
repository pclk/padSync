import { STROKE_STRIDE, type StrokeData } from "@/lib/types";

// Input clean-up for Pencil ink. Stored points stay raw (every existing stroke keeps rendering);
// pressure is filtered at render time, and stray dots are dropped before they are committed.

/**
 * Pencil pressure below this is touchdown or lift, not ink: the first samples of a stroke read
 * ~0 and pointerup always reports 0. Such samples hold the previous pressure instead.
 */
export const PRESSURE_FLOOR = 0.05;
/** Pressure used when a stroke never rises above the floor (perfect-freehand's own default). */
export const PRESSURE_FALLBACK = 0.25;
/**
 * Weight of each new sample in the exponential moving average. The Pencil reports at 240 Hz, so
 * 0.2 is a time constant of ~20 ms: it irons out sample-to-sample noise but follows a press.
 */
export const PRESSURE_ALPHA = 0.2;
/**
 * Largest pressure change between two consecutive samples after the average: a single spiky
 * sample can't swell the line, while a real press (0.5 in ~70 ms at 240 Hz) still comes through.
 */
export const PRESSURE_MAX_STEP = 0.03;

/**
 * Smoothed per-point pressure for a stroke's flat point array. Causal (each value depends only on
 * the samples before it), so the live stroke and the committed stroke get the same widths.
 */
export function smoothPressure(pts: number[]): number[] {
  const n = pts.length / STROKE_STRIDE;
  const out = new Array<number>(n);
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (pts[i * STROKE_STRIDE + 2] >= PRESSURE_FLOOR) {
      first = i;
      break;
    }
  }
  let s = first < 0 ? PRESSURE_FALLBACK : pts[first * STROKE_STRIDE + 2];
  for (let i = 0; i < n; i++) {
    const raw = pts[i * STROKE_STRIDE + 2];
    if (raw >= PRESSURE_FLOOR) {
      const step = PRESSURE_ALPHA * (raw - s);
      s += Math.max(-PRESSURE_MAX_STEP, Math.min(PRESSURE_MAX_STEP, step));
    }
    out[i] = s;
  }
  return out;
}

/** A stroke whose points all lie within this distance (section units) of the first has no length. */
export const DOT_MAX_EXTENT = 1.5;
/** Contact shorter than this is a bounce or a glancing touch; a deliberate tap lasts ~60 ms or more. */
export const DOT_MIN_MS = 45;
/** Pressure at or above this makes even a quick tap deliberate (a firmly placed period). */
export const DOT_MIN_PRESSURE = 0.2;

export interface Contact {
  /** ms from pointerdown to the last event of the gesture, including ones not stored as points. */
  durationMs: number;
  /** Highest raw pressure seen during the gesture. */
  maxPressure: number;
}

/**
 * True for a Pencil touch that should not become ink: no length, AND both brief and light. This is
 * what the Pencil bouncing on touchdown or lift, a resting tip, or a Scribble pointerdown that is
 * cancelled at once look like. A period or an i-dot is kept: it is held a little or pressed.
 */
export function isStrayDot(d: Pick<StrokeData, "pts" | "input">, c: Contact): boolean {
  if (d.input !== "pen") return false;
  const pts = d.pts;
  if (!pts.length) return true;
  const x0 = pts[0];
  const y0 = pts[1];
  for (let i = STROKE_STRIDE; i < pts.length; i += STROKE_STRIDE) {
    if (Math.hypot(pts[i] - x0, pts[i + 1] - y0) > DOT_MAX_EXTENT) return false;
  }
  return c.durationMs < DOT_MIN_MS && c.maxPressure < DOT_MIN_PRESSURE;
}
