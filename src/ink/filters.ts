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
 * What iPadOS Safari reports as the pressure of the first ~30 ms of every Pencil stroke (0.08 as a
 * float32, coalesced samples included): an estimate iPadOS later corrects, but Safari never sends
 * the corrected values. Measured in both iPad recordings: every stroke starts with 1–11 of them.
 */
const PLACEHOLDER_PRESSURE = 0.08;
const isPlaceholder = (p: number) => Math.abs(p - PLACEHOLDER_PRESSURE) < 1e-6;

/**
 * Smoothed per-point pressure for a stroke's flat point array. The leading placeholder samples
 * (PLACEHOLDER_PRESSURE) carry no measurement: they take the first real reading, which also starts
 * the average, so the stroke's start and a quick tap aren't drawn from the estimate. Otherwise
 * causal (each value depends only on the samples before it): the live stroke changes once, when
 * the first real reading arrives, and from then on matches the committed stroke.
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
  let lead = 0;
  while (lead < n && isPlaceholder(pts[lead * STROKE_STRIDE + 2])) lead++;
  const firstFrom = (from: number) => {
    for (let i = from; i < n; i++) if (pts[i * STROKE_STRIDE + 2] >= f.pressureFloor) return i;
    return -1;
  };
  let first = firstFrom(lead);
  // No real reading after the placeholders: they are all there is, so they are used.
  if (first < 0 && lead > 0) [lead, first] = [0, firstFrom(0)];
  let s = first < 0 ? f.pressureFallback : pts[first * STROKE_STRIDE + 2];
  for (let i = 0; i < n; i++) {
    const raw = pts[i * STROKE_STRIDE + 2];
    if (i >= lead && raw >= f.pressureFloor) {
      const step = f.pressureAlpha * (raw - s);
      s += Math.max(-f.pressureMaxStep, Math.min(f.pressureMaxStep, step));
    }
    out[i] = s;
  }
  return out;
}

/** How far back from the last pressed point the stroke's heading is measured (section units). */
const LIFT_OFF_HEADING = 2;

/**
 * A pen stroke's points without Safari's lift-off point when it hooks back: the pointerup sample,
 * the only one with pressure exactly 0, turning 90° or more against the stroke's heading over its
 * last LIFT_OFF_HEADING units. In both iPad recordings it lands a median 3.4 units (p90 6) from the
 * last pressed sample and turns back like this in about half of strokes: where iPadOS estimates the
 * tip left the glass, not where it drew, so those strokes end in a small hook (a "3" closing into
 * an "8"). One that carries on the way the stroke was going is kept, since it can be the real end
 * of a fast tail (y, g, e). So is one after a tap that has no heading. Strokes of fewer than three
 * points keep it. Returns `pts` itself when nothing is left out.
 */
export function withoutLiftOff(pts: number[]): number[] {
  const S = STROKE_STRIDE;
  const n = pts.length / S;
  if (n < 3 || pts[(n - 1) * S + 2] !== 0) return pts;
  const [lx, ly] = [pts[(n - 2) * S], pts[(n - 2) * S + 1]];
  let k = n - 3;
  while (k > 0 && Math.hypot(lx - pts[k * S], ly - pts[k * S + 1]) < LIFT_OFF_HEADING) k--;
  const [hx, hy] = [lx - pts[k * S], ly - pts[k * S + 1]];
  const forward = Math.hypot(hx, hy) >= LIFT_OFF_HEADING && (pts[(n - 1) * S] - lx) * hx + (pts[(n - 1) * S + 1] - ly) * hy > 0;
  return forward ? pts : pts.slice(0, (n - 1) * S);
}

/** A stroke whose points all lie within this distance (section units) of the first has no length. */
export const DOT_MAX_EXTENT = 1.5;
/** Contact shorter than this is a bounce or a glancing touch; a deliberate tap lasts ~60 ms or more. */
export const DOT_MIN_MS = 45;
/** Pressure at or above this makes even a quick tap deliberate (a firmly placed period). */
export const DOT_MIN_PRESSURE = 0.1;

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

/**
 * Share of the stroke's median pressure below which its ends are the tip landing or lifting. It is
 * relative because people write at very different pressures: with a fixed threshold (0.12, before)
 * a light writer's strokes were cut at both ends, shortening a "c" to "(" and opening every "o".
 */
export const HOOK_PRESSURE = 0.3;
/**
 * At most this much of a stroke's length (section units) is trimmed from either end; 0, the
 * default, is off. Any trim takes real ink off the ends of letters, and Noteful trims nothing.
 */
export const HOOK_MAX_LENGTH = 0;

/**
 * Index range [start, end) of a pen stroke without its touchdown and lift-off hooks: the short
 * runs at either end where the tip skids while the pressure ramps up or falls away. Only the
 * ends lighter than `share` of the stroke's median pressure are cut, never more than `maxLength`,
 * and at least two points always remain.
 */
export function hookTrim(input: number[][], rawPressure: number[], share = HOOK_PRESSURE, maxLength = HOOK_MAX_LENGTH): [number, number] {
  const n = input.length;
  if (n < 3 || share <= 0 || maxLength <= 0) return [0, n];
  const sorted = rawPressure.slice().sort((a, b) => a - b);
  const pressure = share * sorted[sorted.length >> 1];
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

/**
 * Jitter radius (section units) of the pen stopping at either end of a stroke. Before lifting,
 * the tip often rests for a few samples, wobbling and pressing harder; drawn as is, that knot of
 * points swells into a blob at the end of a "3" or an "e".
 */
export const STOP_RADIUS = 1.5;

/**
 * Pen points with the knots where the pen stood still at the start and end thinned out: the points
 * jittering within `radius` of where the pen stopped are dropped, but the stop point and the very
 * last point stay (and the first point and landing spot at the start), so the stroke keeps its
 * full length and an "o" still closes.
 */
export function collapseStops(input: number[][], radius = STOP_RADIUS): number[][] {
  const n = input.length;
  if (n < 4 || radius <= 0) return input;
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= radius;
  // End: the earliest k such that every point after k stays within radius of k.
  let stop = n - 1;
  for (let k = n - 2; k >= 1; k--) {
    let all = true;
    for (let j = k + 1; j < n && all; j++) all = near(input[j], input[k]);
    if (!all) break;
    stop = k;
  }
  // Start: the latest k such that every point before k is within radius of k.
  let land = 0;
  for (let k = 1; k < stop; k++) {
    let all = true;
    for (let j = 0; j < k && all; j++) all = near(input[j], input[k]);
    if (!all) break;
    land = k;
  }
  if (land === 0 && stop === n - 1) return input;
  const head = land > 0 ? [input[0]] : [];
  const tail = stop < n - 1 ? [input[n - 1]] : [];
  return [...head, ...input.slice(land, stop + 1), ...tail];
}

/**
 * Largest size (section units, the diagonal of its bounds) of the firmly pressed part of a pen
 * stroke that is drawn as a round dot: a period, an i-dot or a colon. The tip slides a little as
 * it lifts, which would otherwise turn every dot into a short dash. Only points pressed at least
 * TAP_FIRM of the stroke's peak count: a lift-off slide fades out, while a deliberate short dash
 * (a superscript minus) keeps its pressure along its length and stays a dash. The whole touch,
 * slide included, must also fit within TAP_SPREAD times the size, so a letter that ends in a hard
 * press is never mistaken for a dot. And a tap is held still while it is firm (slower than
 * TAP_STILL units per ms), while a quick flick (the bar of a "5") is already moving.
 */
export const TAP_DOT_SIZE = 3;
export const TAP_FIRM = 0.6;
export const TAP_SPREAD = 2.5;
export const TAP_STILL = 0.1;

/** Centre of a tap drawn as a dot (where the pressure peaked), or null for a real stroke. */
export function tapDot(pts: number[], size = TAP_DOT_SIZE): [number, number] | null {
  if (size <= 0 || !pts.length) return null;
  let best = 0;
  for (let i = 0; i < pts.length; i += STROKE_STRIDE) if (pts[i + 2] > pts[best + 2]) best = i;
  const extent = (min: number) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += STROKE_STRIDE) {
      if (pts[i + 2] < min) continue;
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
    return Math.hypot(maxX - minX, maxY - minY);
  };
  const firm = pts[best + 2] * TAP_FIRM;
  // Speed over the firm part: path length from its first to its last firm sample, per ms.
  let first = -1;
  let last = -1;
  for (let i = 0; i < pts.length; i += STROKE_STRIDE) {
    if (pts[i + 2] < firm) continue;
    if (first < 0) first = i;
    last = i;
  }
  let travel = 0;
  for (let i = first + STROKE_STRIDE; i <= last; i += STROKE_STRIDE) travel += Math.hypot(pts[i] - pts[i - STROKE_STRIDE], pts[i + 1] - pts[i + 1 - STROKE_STRIDE]);
  const still = travel / Math.max(4, pts[last + 5] - pts[first + 5]) <= TAP_STILL;
  const isTap = still && extent(-Infinity) <= size * TAP_SPREAD && extent(firm) <= size;
  return isTap ? [pts[best], pts[best + 1]] : null;
}

/**
 * Longest lift-off or landing tail (section units) that is trimmed; 0, the default, is off. At
 * handwriting size a sharp turn near an end is usually part of the letter (the top of an "f" or a
 * "7", the bars of a "z", the loop of a "6"), and cutting those made letters unreadable. Moving on to the next stroke,
 * the tip often keeps touching for a few millimetres: a fraction bar ends in a hook, the top of an
 * "=" bends into a "2", a "0" gets a tail inside it. Such a tail turns sharply away from the
 * stroke and is lighter or faster than the rest of it.
 */
export const TAIL_MAX_LENGTH = 0;
/** Smallest turn (degrees) between a stroke and a tail. */
export const TAIL_MIN_TURN = 70;
/** A tail is never more than this share of the stroke's length. */
const TAIL_MAX_SHARE = 0.4;
/** Lighter than this share of the stroke's median pressure, or faster than this multiple of its speed. */
const TAIL_PRESSURE = 0.8;
const TAIL_SPEED = 1.5;

/**
 * Index range [start, end) without a lift-off tail at the end or a landing tail at the start: the
 * part after the sharpest turn within `maxLength` of an end, when that part is both lighter and
 * faster than the stroke. Firm, steady turns (the foot of a "2", the hook of a "J") stay.
 */
export function tailTrim(input: number[][], raw: number[], times: number[], maxLength = TAIL_MAX_LENGTH, minTurn = TAIL_MIN_TURN): [number, number] {
  const n = input.length;
  if (n < 6 || maxLength <= 0) return [0, n];
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(input[i][0] - input[i - 1][0], input[i][1] - input[i - 1][1]);
  const total = s[n - 1];
  const reach = Math.min(maxLength, TAIL_MAX_SHARE * total);
  const ARM = 3;
  // Turn at k: angle between the 3-unit run into k and the 3-unit run out of it.
  const turn = (k: number) => {
    let a = k;
    while (a > 0 && s[k] - s[a] < ARM) a--;
    let b = k;
    while (b < n - 1 && s[b] - s[k] < ARM) b++;
    if (a === k || b === k) return 0;
    const ux = input[k][0] - input[a][0], uy = input[k][1] - input[a][1];
    const vx = input[b][0] - input[k][0], vy = input[b][1] - input[k][1];
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  const median = (from: number, to: number) => {
    const v = raw.slice(from, to).sort((x, y) => x - y);
    return v.length ? v[v.length >> 1] : 0;
  };
  const mean = (from: number, to: number) => raw.slice(from, to).reduce((a, b) => a + b, 0) / Math.max(1, to - from);
  const speed = (from: number, to: number) => (s[to] - s[from]) / Math.max(1, times[to] - times[from]);
  // Lighter or faster than the body of the stroke.
  const loose = (tail: [number, number], body: [number, number]) =>
    mean(tail[0], tail[1] + 1) < TAIL_PRESSURE * median(body[0], body[1] + 1) && speed(tail[0], tail[1]) > TAIL_SPEED * speed(body[0], body[1]);

  let end = n;
  let best = -1;
  let bestTurn = minTurn;
  for (let k = n - 2; k > 0 && s[n - 1] - s[k] <= reach; k--) {
    const t = turn(k);
    if (t >= bestTurn) [best, bestTurn] = [k, t];
  }
  if (best > 0 && loose([best, n - 1], [0, best])) end = best + 1;

  let start = 0;
  best = -1;
  bestTurn = minTurn;
  for (let k = 1; k < end - 1 && s[k] <= reach; k++) {
    const t = turn(k);
    if (t >= bestTurn) [best, bestTurn] = [k, t];
  }
  if (best > 0 && loose([0, best], [best, end - 1])) start = best;
  return end - start >= 2 ? [start, end] : [0, n];
}
