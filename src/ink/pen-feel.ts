// Pen feel: every parameter that shapes a pen stroke, adjustable in the pen settings. Each stroke
// stores the values it was drawn with that differ from the defaults (StrokeData.pen), so changing
// the settings never restyles existing ink and every device draws a stroke the same way.

import {
  BACKTRACK_MAX,
  DOT_MAX_EXTENT,
  DOT_MIN_MS,
  DOT_MIN_PRESSURE,
  HOOK_MAX_LENGTH,
  HOOK_PRESSURE,
  MAX_POINT_GAP,
  POSITION_SIGMA,
  PRESSURE_ALPHA,
  PRESSURE_FALLBACK,
  PRESSURE_FLOOR,
  PRESSURE_MAX_STEP,
} from "./filters";

export const EASINGS = {
  linear: (t: number) => t,
  sine: (t: number) => Math.sin((t * Math.PI) / 2),
  "ease-in": (t: number) => t * t,
  "ease-out": (t: number) => t * (2 - t),
  cubic: (t: number) => 1 - (1 - t) ** 3,
} as const;
export type Easing = keyof typeof EASINGS;

export interface PenParams {
  streamline: number;
  smoothing: number;
  positionSigma: number;
  thinning: number;
  easing: Easing;
  simulatePressure: boolean;
  taperStart: number;
  taperEnd: number;
  capStart: boolean;
  capEnd: boolean;
  maxPointGap: number;
  backtrackMax: number;
  hookPressure: number;
  hookMaxLength: number;
  pressureFloor: number;
  pressureFallback: number;
  pressureAlpha: number;
  pressureMaxStep: number;
  dotMaxExtent: number;
  dotMinMs: number;
  dotMinPressure: number;
  maxPredicted: number;
  dropOutOfOrder: boolean;
}

export const DEFAULT_PEN: PenParams = {
  streamline: 0.35,
  smoothing: 0.55,
  positionSigma: POSITION_SIGMA,
  thinning: 0.3,
  easing: "linear",
  simulatePressure: false,
  taperStart: 0,
  taperEnd: 0,
  capStart: true,
  capEnd: true,
  maxPointGap: MAX_POINT_GAP,
  backtrackMax: BACKTRACK_MAX,
  hookPressure: HOOK_PRESSURE,
  hookMaxLength: HOOK_MAX_LENGTH,
  pressureFloor: PRESSURE_FLOOR,
  pressureFallback: PRESSURE_FALLBACK,
  pressureAlpha: PRESSURE_ALPHA,
  pressureMaxStep: PRESSURE_MAX_STEP,
  dotMaxExtent: DOT_MAX_EXTENT,
  dotMinMs: DOT_MIN_MS,
  dotMinPressure: DOT_MIN_PRESSURE,
  maxPredicted: 2,
  dropOutOfOrder: true,
};

type Key = keyof PenParams;
export type PenParamSpec =
  | { key: Key; label: string; help: string; kind: "range"; min: number; max: number; step: number; unit?: string }
  | { key: Key; label: string; help: string; kind: "toggle" }
  | { key: Key; label: string; help: string; kind: "select"; options: readonly string[] };

/** Every pen parameter, grouped as the settings show them. Ranges also bound synced values. */
export const PEN_GROUPS: { title: string; note?: string; params: PenParamSpec[] }[] = [
  {
    title: "Line",
    params: [
      { key: "streamline", label: "Streamline", kind: "range", min: 0, max: 0.95, step: 0.01, help: "How far the line trails behind the tip to calm wobble. High values round off corners." },
      { key: "smoothing", label: "Outline smoothing", kind: "range", min: 0, max: 1, step: 0.01, help: "Softens the edges of the line's outline." },
      { key: "positionSigma", label: "Path smoothing", kind: "range", min: 0, max: 6, step: 0.1, unit: "px", help: "Averages the path over this distance. 0 turns it off; large values blur small letters." },
      { key: "thinning", label: "Pressure → width", kind: "range", min: -0.95, max: 0.95, step: 0.01, help: "How much pressure changes the width. 0 is an even line; negative makes light strokes thicker." },
      { key: "easing", label: "Pressure curve", kind: "select", options: Object.keys(EASINGS), help: "Shape of the pressure-to-width curve. Sine draws about 1.4× thicker at mid pressure." },
      { key: "simulatePressure", label: "Simulate pressure", kind: "toggle", help: "Ignore the Pencil's pressure and vary width with speed instead, like the trackpad." },
    ],
  },
  {
    title: "Ends",
    params: [
      { key: "taperStart", label: "Taper start", kind: "range", min: 0, max: 60, step: 1, unit: "px", help: "Thins the first part of each stroke to a point." },
      { key: "taperEnd", label: "Taper end", kind: "range", min: 0, max: 60, step: 1, unit: "px", help: "Thins the last part of each stroke to a point." },
      { key: "capStart", label: "Round start", kind: "toggle", help: "Round cap where a stroke begins (when not tapered)." },
      { key: "capEnd", label: "Round end", kind: "toggle", help: "Round cap where a stroke ends (when not tapered)." },
    ],
  },
  {
    title: "Path clean-up",
    note: "Applied when drawing, so they also change how strokes drawn earlier with the same values look.",
    params: [
      { key: "maxPointGap", label: "Curve between samples", kind: "range", min: 0.5, max: 20, step: 0.5, unit: "px", help: "Samples further apart than this are joined by a curve. Large values draw straight pieces." },
      { key: "backtrackMax", label: "Drop backward jumps", kind: "range", min: 0, max: 20, step: 0.5, unit: "px", help: "A single sample stepping back by up to this much is dropped. 0 turns it off." },
      { key: "hookPressure", label: "Hook pressure", kind: "range", min: 0, max: 0.5, step: 0.01, help: "Stroke ends lighter than this are trimmed as touchdown or lift-off hooks. 0 turns it off." },
      { key: "hookMaxLength", label: "Hook length", kind: "range", min: 0, max: 30, step: 0.5, unit: "px", help: "Most that is trimmed from either end." },
    ],
  },
  {
    title: "Pressure filter",
    params: [
      { key: "pressureAlpha", label: "Response", kind: "range", min: 0.01, max: 1, step: 0.01, help: "How quickly width follows pressure. 1 uses raw pressure; low values are calmer." },
      { key: "pressureMaxStep", label: "Max change per sample", kind: "range", min: 0.001, max: 1, step: 0.001, help: "Caps how fast width can change, so one spiky sample can't swell the line." },
      { key: "pressureFloor", label: "Ignore below", kind: "range", min: 0, max: 0.3, step: 0.01, help: "Pressure under this (touchdown, lift) holds the previous value." },
      { key: "pressureFallback", label: "Fallback pressure", kind: "range", min: 0.05, max: 1, step: 0.01, help: "Used when a stroke never rises above the floor." },
    ],
  },
  {
    title: "Taps and prediction",
    note: "Applied while you write; changing them doesn't affect existing strokes.",
    params: [
      { key: "dotMinMs", label: "Stray dot: shorter than", kind: "range", min: 0, max: 200, step: 5, unit: "ms", help: "A tap shorter than this, and lighter than below, is dropped as a bounce. 0 keeps every tap." },
      { key: "dotMinPressure", label: "Stray dot: lighter than", kind: "range", min: 0, max: 1, step: 0.01, help: "A tap pressed at least this hard is always kept." },
      { key: "dotMaxExtent", label: "Stray dot: size", kind: "range", min: 0, max: 10, step: 0.5, unit: "px", help: "Only touches that stay within this distance count as taps." },
      { key: "maxPredicted", label: "Predicted points", kind: "range", min: 0, max: 8, step: 1, help: "Points ahead of the tip drawn while writing, to hide latency. More can overshoot." },
      { key: "dropOutOfOrder", label: "Drop out-of-order samples", kind: "toggle", help: "Ignore samples older than the last one (re-sent by the browser)." },
    ],
  },
];

const SPECS = new Map(PEN_GROUPS.flatMap((g) => g.params.map((p) => [p.key, p] as const)));

/** A value from storage or sync, kept only if it fits its parameter (numbers clamped to range). */
function valid(key: Key, v: unknown): PenParams[Key] | undefined {
  const spec = SPECS.get(key);
  if (!spec) return undefined;
  if (spec.kind === "toggle") return typeof v === "boolean" ? v : undefined;
  if (spec.kind === "select") return typeof v === "string" && spec.options.includes(v) ? (v as Easing) : undefined;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : undefined;
}

/** Full parameters from defaults plus valid overrides; anything malformed is ignored. */
export function withOverrides(overrides?: Partial<Record<string, unknown>> | null): PenParams {
  const out: PenParams = { ...DEFAULT_PEN };
  if (!overrides || typeof overrides !== "object") return out;
  for (const key of Object.keys(DEFAULT_PEN) as Key[]) {
    const v = valid(key, overrides[key]);
    if (v !== undefined) (out as unknown as Record<Key, PenParams[Key]>)[key] = v;
  }
  return out;
}

/** Only the parameters that differ from the defaults: what a stroke stores. */
export function penOverrides(p: PenParams): Partial<PenParams> {
  const out: Partial<Record<Key, PenParams[Key]>> = {};
  for (const key of Object.keys(DEFAULT_PEN) as Key[]) if (p[key] !== DEFAULT_PEN[key]) out[key] = p[key];
  return out as Partial<PenParams>;
}

// Quick controls. Each sets several parameters; the full list can then fine-tune them.

/** Smoothness 0–1 → streamline, outline smoothing and path smoothing. 0.5 gives the defaults. */
export function setSmoothness(p: PenParams, s: number): PenParams {
  const v = Math.min(1, Math.max(0, s));
  return { ...p, streamline: round2(0.1 + 0.5 * v), smoothing: round2(0.35 + 0.4 * v), positionSigma: round2(0.5 + 2 * v) };
}
export const smoothnessOf = (p: PenParams) => Math.min(1, Math.max(0, (p.streamline - 0.1) / 0.5));

/** Pressure 0–1 → thinning. 0.4 gives the default. */
export function setPressure(p: PenParams, s: number): PenParams {
  return { ...p, thinning: round2(0.75 * Math.min(1, Math.max(0, s))) };
}
export const pressureOf = (p: PenParams) => Math.min(1, Math.max(0, p.thinning / 0.75));

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Parameters a stroke was drawn with: its stored overrides, or for strokes from before they were
 * stored, the two quick values they kept (smoothing, sensitivity), or the defaults.
 */
export function strokePen(d: { pen?: Partial<Record<string, unknown>>; smoothing?: number; sensitivity?: number }): PenParams {
  if (d.pen) return withOverrides(d.pen);
  let p = DEFAULT_PEN;
  if (d.smoothing !== undefined) p = setSmoothness(p, d.smoothing);
  if (d.sensitivity !== undefined) p = setPressure(p, d.sensitivity);
  return p;
}

/** Tool overrides for tool state saved before the full parameters existed. */
export function legacyOverrides(smoothing?: number, sensitivity?: number): Partial<PenParams> {
  let p = DEFAULT_PEN;
  if (smoothing !== undefined) p = setSmoothness(p, smoothing);
  if (sensitivity !== undefined) p = setPressure(p, sensitivity);
  return penOverrides(p);
}
