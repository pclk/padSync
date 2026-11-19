// The iPad's circle menus (tools, chat prompts): press and hold, the items fan out around the
// press, and the direction the finger then moves picks one. Pure geometry in viewport px and degrees (0° points
// right, 90° down, as on screen), so the tests can check it without a DOM.

/** How far from the circle's centre the tools fan out. */
export const FAN_RADIUS = 96;
/** Finger travel below this picks nothing, so a wobble while holding doesn't choose a tool. */
export const PICK_DEAD_ZONE = 28;
/** Hold this long without moving and the fan opens; letting go sooner is a tap. */
export const HOLD_MS = 180;
/** A press that moves further than this has started a drag. */
export const DRAG_SLOP = 10;

const FAN_STEP = 45;
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Angles for `n` tools, fanned over up to a half circle, centred on the direction from the circle
 * towards the middle of the screen: away from the edge it is docked to, and diagonally out of a
 * corner, so the fan stays on screen wherever the circle sits.
 */
export function fanAngles(n: number, center: [number, number], viewport: [number, number]): number[] {
  if (n <= 0) return [];
  const dir = deg(Math.atan2(viewport[1] / 2 - center[1], viewport[0] / 2 - center[0]));
  if (n === 1) return [dir];
  const span = Math.min(180, FAN_STEP * (n - 1));
  return Array.from({ length: n }, (_, i) => dir - span / 2 + (i * span) / (n - 1));
}

/** Room each item needs along the arc, so neighbouring bubbles don't touch. */
const ITEM_ARC = 62;
/** Space a full ring needs past its radius on every side (bubbles and their labels). */
const RING_MARGIN = 70;

export interface FanLayout {
  angles: number[];
  radius: number;
}

/**
 * Angles and radius for `n` items around `center`. With room on every side (a gesture in the
 * middle of the page) they make a full ring starting at the top; near an edge or a corner they
 * fan out over up to a half circle facing the middle of the screen (fanAngles). The radius grows
 * when there are too many items to fit around the default one.
 */
export function fanLayout(n: number, center: [number, number], viewport: [number, number], top = 0): FanLayout {
  if (n <= 0) return { angles: [], radius: FAN_RADIUS };
  const ring = 360 / n;
  const ringRadius = Math.max(FAN_RADIUS, ITEM_ARC / rad(ring));
  const room = Math.min(center[0], center[1] - top, viewport[0] - center[0], viewport[1] - center[1]);
  if (n > 2 && room >= ringRadius + RING_MARGIN) return { angles: Array.from({ length: n }, (_, i) => -90 + i * ring), radius: ringRadius };
  const angles = fanAngles(n, center, viewport);
  const step = n > 1 ? Math.abs(angles[1] - angles[0]) : 180;
  return { angles, radius: Math.max(FAN_RADIUS, ITEM_ARC / rad(step)) };
}

/** Where the item at `angle` is drawn, its centre clamped `inset` px inside the viewport. */
export function fanPoint(angle: number, center: [number, number], viewport: [number, number], inset = 30, radius = FAN_RADIUS): [number, number] {
  const x = center[0] + radius * Math.cos(rad(angle));
  const y = center[1] + radius * Math.sin(rad(angle));
  return [Math.min(viewport[0] - inset, Math.max(inset, x)), Math.min(viewport[1] - inset, Math.max(inset, y))];
}

/** Smallest difference between two angles, 0–180°. */
const between = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/** Pointing further than this from every tool (back towards the edge) picks nothing. */
export const PICK_MAX_OFF = 70;

/**
 * The tool the finger points at: the one whose angle is closest to the direction it moved from
 * where it pressed, so a rough flick is enough. -1 inside the dead zone, or when pointing away
 * from the fan, which is how you let go without changing tool.
 */
export function pickByDirection(angles: number[], dx: number, dy: number): number {
  if (!angles.length || Math.hypot(dx, dy) < PICK_DEAD_ZONE) return -1;
  const a = deg(Math.atan2(dy, dx));
  let best = 0;
  for (let i = 1; i < angles.length; i++) if (between(a, angles[i]) < between(a, angles[best])) best = i;
  return between(a, angles[best]) <= PICK_MAX_OFF ? best : -1;
}
