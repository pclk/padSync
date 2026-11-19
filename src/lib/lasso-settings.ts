// How the lasso behaves on this device (Settings → Lasso, or the Lasso tab of the iPad's toolbar
// settings): how it picks strokes, and the circle of actions that appears above a selection.
import type { IconName } from "@/components/Icons";
import type { LassoMode } from "@/ink/geometry";

export type LassoAction = "delete" | "duplicate" | "recolor" | "bigger" | "smaller" | "ask" | "done";

export const LASSO_ACTIONS: { action: LassoAction; label: string; icon: IconName; hint: string }[] = [
  { action: "delete", label: "Delete", icon: "trash", hint: "Remove the selected ink." },
  { action: "duplicate", label: "Duplicate", icon: "copy", hint: "A copy just below and to the right, selected to drag into place." },
  { action: "recolor", label: "Colour", icon: "sparkles", hint: "Fans out the pen colours; the one you pick colours all of it." },
  { action: "bigger", label: "Bigger", icon: "plus", hint: "Scale up by the step below, line widths too." },
  { action: "smaller", label: "Smaller", icon: "minus", hint: "Scale down by the step below." },
  { action: "ask", label: "Ask AI", icon: "message", hint: "Fans out your prompts and sends the one you pick with the selection." },
  { action: "done", label: "Done", icon: "tick", hint: "Clear the selection." },
];

export interface LassoSettings {
  lens: boolean;
  lensSize: number;
  lensZoom: number;
  mode: LassoMode;
  /** The circle of actions above a selection; off, the bar of buttons shows instead. */
  circle: boolean;
  /** The circle's actions, in fan order, and those hidden. */
  order: LassoAction[];
  hidden: LassoAction[];
  /** The circle's diameter (px). */
  size: number;
  /** How much Bigger and Smaller scale by, as a percentage. */
  step: number;
}

export const LASSO_KEY = "padsync.lasso";
export const LASSO_SIZES = { min: 36, max: 96, step: 4 } as const;
export const LASSO_STEPS = { min: 5, max: 100, step: 5 } as const;

/** The circle by default on the iPad, where there is no keyboard; the Mac keeps the bar. */
export const defaultLasso = (ipad: boolean): LassoSettings => ({
  lens: true,
  lensSize: 104,
  lensZoom: 2,
  mode: "touch",
  circle: ipad,
  order: LASSO_ACTIONS.map((a) => a.action),
  hidden: [],
  size: 52,
  step: 25,
});

const isAction = (v: unknown): v is LassoAction => LASSO_ACTIONS.some((a) => a.action === v);
const num = (v: unknown, r: { min: number; max: number }, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : fallback;

export function normalizeLasso(raw: unknown, ipad: boolean): LassoSettings {
  const d = defaultLasso(ipad);
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<LassoSettings>;
  const order = [...new Set((Array.isArray(r.order) ? r.order : []).filter(isAction))];
  for (const a of d.order) if (!order.includes(a)) order.push(a);
  return {
    lens: typeof r.lens === "boolean" ? r.lens : d.lens,
    lensSize: num(r.lensSize, { min: 72, max: 160 }, d.lensSize),
    lensZoom: num(r.lensZoom, { min: 2, max: 4 }, d.lensZoom),
    mode: r.mode === "enclose" || r.mode === "touch" ? r.mode : d.mode,
    circle: typeof r.circle === "boolean" ? r.circle : d.circle,
    order,
    hidden: [...new Set((Array.isArray(r.hidden) ? r.hidden : []).filter(isAction))],
    size: num(r.size, LASSO_SIZES, d.size),
    step: num(r.step, LASSO_STEPS, d.step),
  };
}

export const visibleLassoActions = (s: LassoSettings) => s.order.filter((a) => !s.hidden.includes(a));
