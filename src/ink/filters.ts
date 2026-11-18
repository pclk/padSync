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
export interface PressureFilter {
  pressureFloor: number;
  pressureFallback: number;
  pressureAlpha: number;
  pressureMaxStep: number;
}

const PRESSURE_DEFAULTS: PressureFilter = { pressureFloor: PRESSURE_FLOOR, pressureFallback: PRESSURE_FALLBACK, pressureAlpha: PRESSURE_ALPHA, pressureMaxStep: PRESSURE_MAX_STEP };

export function smoothPressure(pts: number[], f: PressureFilter = PRESSURE_DEFAULTS): number[] {
  const n = pts.length / STROKE_STRIDE;
  const out = new Array<number>(n);
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (pts[i * STROKE_STRIDE + 2] >= f.pressureFloor) {
      first = i;
      break;
    }
  }
  let s = first < 0 ? f.pressureFallback : pts[first * STROKE_STRIDE + 2];
  for (let i = 0; i < n; i++) {
    const raw = pts[i * STROKE_STRIDE + 2];
    if (raw >= f.pressureFloor) {
      const step = f.pressureAlpha * (raw - s);
      s += Math.max(-f.pressureMaxStep, Math.min(f.pressureMaxStep, step));
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
export interface DotFilter {
  dotMaxExtent: number;
  dotMinMs: number;
  dotMinPressure: number;
}

const DOT_DEFAULTS: DotFilter = { dotMaxExtent: DOT_MAX_EXTENT, dotMinMs: DOT_MIN_MS, dotMinPressure: DOT_MIN_PRESSURE };

export function isStrayDot(d: Pick<StrokeData, "pts" | "input">, c: Contact, f: DotFilter = DOT_DEFAULTS): boolean {
  if (d.input !== "pen") return false;
  const pts = d.pts;
  if (!pts.length) return true;
  const x0 = pts[0];
  const y0 = pts[1];
  for (let i = STROKE_STRIDE; i < pts.length; i += STROKE_STRIDE) {
    if (Math.hypot(pts[i] - x0, pts[i + 1] - y0) > f.dotMaxExtent) return false;
  }
  return c.durationMs < f.dotMinMs && c.maxPressure < f.dotMinPressure;
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
export function dropBacktracks(input: number[][], times?: number[], max = BACKTRACK_MAX): number[][] {
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
        if (dx * sx + dy * sy < 0 && Math.hypot(sx, sy) <= max && dx * (next[0] - prev[0]) + dy * (next[1] - prev[1]) > 0) continue;
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

/**
 * Longest gap (section units) left between rendered Pencil points. When the Pencil delivers
 * fewer samples than its 240 Hz (Safari often hands over one per frame), fast handwriting has
 * 5–15 px between samples: drawn straight they make angular letters, and perfect-freehand's
 * per-sample streamline then cuts across small loops (an "o" or an "a" collapses). Curving
 * through the samples at this spacing makes every later step behave the same at any rate.
 */
export const MAX_POINT_GAP = 1.5;

/**
 * Pen points with Catmull–Rom curves through the samples wherever two are further apart than
 * `gap`. Pressure is interpolated linearly. Dense input comes back unchanged.
 */
export function interpolateGaps(input: number[][], gap = MAX_POINT_GAP): number[][] {
  const n = input.length;
  if (n < 2 || !(gap > 0)) return input;
  let needed = false;
  for (let i = 1; i < n && !needed; i++) needed = Math.hypot(input[i][0] - input[i - 1][0], input[i][1] - input[i - 1][1]) > gap;
  if (!needed) return input;
  const out: number[][] = [input[0]];
  for (let i = 1; i < n; i++) {
    const p0 = input[Math.max(0, i - 2)];
    const p1 = input[i - 1];
    const p2 = input[i];
    const p3 = input[Math.min(n - 1, i + 1)];
    const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / gap);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]), p1[2] + (p2[2] - p1[2]) * t]);
    }
    out.push(p2);
  }
  return out;
}

/** Raw Pencil pressure below this at a stroke's ends is the tip landing or lifting, not ink. */
export const HOOK_PRESSURE = 0.12;
/** At most this much of a stroke's length (section units) is trimmed from either end. */
export const HOOK_MAX_LENGTH = 6;

/**
 * Index range [start, end) of a pen stroke without its touchdown and lift-off hooks: the short
 * runs at either end where the tip skids while the pressure ramps up or falls away. Only the
 * light ends are cut, never more than HOOK_MAX_LENGTH, and at least two points always remain.
 */
export function hookTrim(input: number[][], rawPressure: number[], pressure = HOOK_PRESSURE, maxLength = HOOK_MAX_LENGTH): [number, number] {
  const n = input.length;
  let start = 0;
  let len = 0;
  while (start < n - 2 && rawPressure[start] < pressure) {
    len += Math.hypot(input[start + 1][0] - input[start][0], input[start + 1][1] - input[start][1]);
    if (len > maxLength) break;
    start++;
  }
  let end = n;
  len = 0;
  while (end - 1 > start + 1 && rawPressure[end - 1] < pressure) {
    len += Math.hypot(input[end - 1][0] - input[end - 2][0], input[end - 1][1] - input[end - 2][1]);
    if (len > maxLength) break;
    end--;
  }
  return [start, end];
}
