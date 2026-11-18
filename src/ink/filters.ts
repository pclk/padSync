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

/**
 * Largest backward step (section units) treated as a re-sent sample rather than the pen turning.
 * On the iPad a sample sometimes lands a couple of samples behind the tip once per frame; drawn
 * as is, the outline folds back on itself there and the line looks like a chain of pinched pieces.
 */
export const BACKTRACK_MAX = 6;

/**
 * Pen positions for rendering with single-sample backtracks removed: a point that steps back
 * against the stroke's direction (by at most BACKTRACK_MAX) while the point after it carries on
 * past the previous one. A real reversal (an arrowhead, a scribble) does not resume forward at
 * once, so it is kept. Samples whose time runs backwards are dropped too. The first and last
 * points always stay, and the input array is returned unchanged when nothing is dropped.
 */
export function dropBacktracks(input: number[][], times?: number[]): number[][] {
  const n = input.length;
  if (n < 4) return input;
  const out: number[][] = [input[0]];
  let lastT = times ? times[0] : 0;
  for (let i = 1; i < n; i++) {
    const p = input[i];
    if (i < n - 1) {
      if (times && times[i] < lastT) continue;
      const prev = out[out.length - 1];
      const back = out.length >= 2 ? out[out.length - 2] : null;
      if (back) {
        const dx = prev[0] - back[0];
        const dy = prev[1] - back[1];
        const sx = p[0] - prev[0];
        const sy = p[1] - prev[1];
        const next = input[i + 1];
        if (dx * sx + dy * sy < 0 && Math.hypot(sx, sy) <= BACKTRACK_MAX && dx * (next[0] - prev[0]) + dy * (next[1] - prev[1]) > 0) continue;
      }
    }
    if (times) lastT = Math.max(lastT, times[i]);
    out.push(p);
  }
  return out.length === n ? input : out;
}

/**
 * Width (section units, ~CSS px) of the Gaussian that smooths Pencil positions. Measured along
 * the stroke rather than in samples, so 240 Hz Pencil input is smoothed exactly like sparser
 * input; small enough that the corners of an x or a 4 stay sharp to the eye.
 */
export const POSITION_SIGMA = 1.5;

/**
 * Pen positions smoothed with a Gaussian over arc length (±2σ). Irons out sample jitter and
 * per-frame wobble that perfect-freehand's per-sample streamline barely touches at 240 Hz. The
 * first and last points stay where they were, so strokes still start and end at the pen.
 */
export function smoothPositions(input: number[][], sigma = POSITION_SIGMA): number[][] {
  const n = input.length;
  if (n < 3 || sigma <= 0) return input;
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(input[i][0] - input[i - 1][0], input[i][1] - input[i - 1][1]);
  const reach = 2 * sigma;
  const out: number[][] = [input[0]];
  for (let i = 1; i < n - 1; i++) {
    // Never reach past either end: a point near the start averages a shorter, symmetric window.
    const r = Math.min(reach, s[i], s[n - 1] - s[i]);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = i; k >= 0 && s[i] - s[k] <= r; k--) {
      const w = Math.exp(-((s[i] - s[k]) ** 2) / (2 * sigma * sigma));
      sx += input[k][0] * w;
      sy += input[k][1] * w;
      sw += w;
    }
    for (let k = i + 1; k < n && s[k] - s[i] <= r; k++) {
      const w = Math.exp(-((s[k] - s[i]) ** 2) / (2 * sigma * sigma));
      sx += input[k][0] * w;
      sy += input[k][1] * w;
      sw += w;
    }
    out.push([sx / sw, sy / sw, input[i][2]]);
  }
  out.push(input[n - 1]);
  return out;
}
