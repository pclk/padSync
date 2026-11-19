// Finger gestures on the iPad and what each one does, chosen in Settings. The recognizer is pure
// (fed touch positions and times, timers injected), so the tests can drive it without a DOM.
import type { ToolKind } from "@/ink/controller";

export type GestureKind = "twoTap" | "threeTap" | "fourTap" | "twoDoubleTap" | "fingerDoubleTap" | "fingerHold";

export type GestureAction =
  | "none"
  | "undo"
  | "redo"
  | "previousTool"
  | `tool:${ToolKind}`
  | "togglePanel"
  | "resetZoom";

export type GestureBindings = Record<GestureKind, GestureAction>;

export const GESTURES: { kind: GestureKind; label: string; hint: string }[] = [
  { kind: "twoTap", label: "Two-finger tap", hint: "Tap two fingers anywhere." },
  { kind: "threeTap", label: "Three-finger tap", hint: "Tap three fingers anywhere." },
  { kind: "fourTap", label: "Four-finger tap", hint: "Tap four fingers anywhere. Turn off iPadOS multitasking gestures if the system takes it." },
  { kind: "twoDoubleTap", label: "Two-finger double tap", hint: "Tap two fingers twice. While this is set, a two-finger tap waits a moment to see whether a second one follows." },
  { kind: "fingerDoubleTap", label: "Finger double tap", hint: "Tap one finger twice on the page." },
  { kind: "fingerHold", label: "Finger press and hold", hint: "Hold one finger still on the page for half a second." },
];

export const GESTURE_ACTIONS: { action: GestureAction; label: string }[] = [
  { action: "none", label: "Nothing" },
  { action: "undo", label: "Undo" },
  { action: "redo", label: "Redo" },
  { action: "previousTool", label: "Switch to the previous tool" },
  { action: "tool:pen", label: "Pen" },
  { action: "tool:highlighter", label: "Highlighter" },
  { action: "tool:eraser", label: "Eraser" },
  { action: "tool:lasso", label: "Lasso" },
  { action: "tool:text", label: "Text" },
  { action: "togglePanel", label: "Show or hide the side panel" },
  { action: "resetZoom", label: "Reset zoom" },
];

export const GESTURES_KEY = "padsync.gestures";
/** As before gestures could be changed: two fingers undo, three redo, nothing else. */
export const DEFAULT_GESTURES: GestureBindings = {
  twoTap: "undo",
  threeTap: "redo",
  fourTap: "none",
  twoDoubleTap: "none",
  fingerDoubleTap: "none",
  fingerHold: "none",
};

const isAction = (v: unknown): v is GestureAction => GESTURE_ACTIONS.some((a) => a.action === v);

/** A stored map is valid if it is an object; normalizeGestures fills in what it lacks. */
export const isGestureMap = (v: unknown): v is Partial<GestureBindings> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeGestures(raw: Partial<GestureBindings> | null | undefined): GestureBindings {
  const out = { ...DEFAULT_GESTURES };
  for (const g of GESTURES) {
    const v = raw?.[g.kind];
    if (isAction(v)) out[g.kind] = v;
  }
  return out;
}

export const actionLabel = (a: GestureAction) => GESTURE_ACTIONS.find((x) => x.action === a)?.label ?? a;

/** Lift within this long, without moving, and it was a tap. */
export const TAP_MS = 280;
/** Fingers that move further than this are scrolling or pinching, not tapping. */
export const TAP_SLOP = 12;
/** A second tap within this long, and this close, makes a double tap. */
export const DOUBLE_MS = 300;
export const DOUBLE_SLOP = 40;
/** Hold one finger still this long and it is a press and hold. */
export const HOLD_MS = 500;
/** One-finger gestures are ignored this soon after the Pencil, so a resting palm triggers nothing. */
export const PENCIL_QUIET_MS = 800;

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

interface Contact {
  t0: number;
  most: number;
  moved: boolean;
  start: Map<number, [number, number]>;
  /** One-finger gestures only count on the page itself, not on controls or a text box. */
  onPage: boolean;
  /** The Pencil was in use: one-finger gestures are off for this contact. */
  pencil: boolean;
  held: boolean;
  holdTimer: unknown;
}

/**
 * Turns finger touches into gestures. Call `start`, `move` and `end` with the fingers down after
 * each touch event (Pencil touches left out) and `pencil` whenever the Pencil touches.
 */
export class GestureRecognizer {
  private contact: Contact | null = null;
  private lastPencil = -Infinity;
  /** A tap that might become a double tap: what it was, when, where, and the pending single. */
  private pending: { n: number; t: number; at: [number, number]; timer: unknown } | null = null;

  constructor(
    private emit: (g: GestureKind) => void,
    private isBound: (g: GestureKind) => boolean,
    private timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  ) {}

  pencil(now: number) {
    this.lastPencil = now;
    if (this.contact) {
      this.contact.pencil = true;
      this.timers.clear(this.contact.holdTimer);
    }
  }

  start(fingers: TouchPoint[], now: number, onPage: boolean) {
    if (!fingers.length) return;
    if (!this.contact) {
      this.contact = { t0: now, most: 0, moved: false, start: new Map(), onPage, pencil: now - this.lastPencil < PENCIL_QUIET_MS, held: false, holdTimer: null };
      if (fingers.length === 1 && onPage && !this.contact.pencil && this.isBound("fingerHold")) {
        const c = this.contact;
        c.holdTimer = this.timers.set(() => {
          if (this.contact !== c || c.moved || c.most !== 1 || c.pencil) return;
          c.held = true;
          this.emit("fingerHold");
        }, HOLD_MS);
      }
    }
    const c = this.contact;
    for (const f of fingers) if (!c.start.has(f.id)) c.start.set(f.id, [f.x, f.y]);
    c.most = Math.max(c.most, fingers.length);
    if (c.most > 1) this.timers.clear(c.holdTimer);
  }

  move(fingers: TouchPoint[]) {
    const c = this.contact;
    if (!c || c.moved) return;
    c.moved = fingers.some((f) => {
      const s = c.start.get(f.id);
      return s && Math.hypot(f.x - s[0], f.y - s[1]) > TAP_SLOP;
    });
    if (c.moved) this.timers.clear(c.holdTimer);
  }

  end(fingers: TouchPoint[], now: number) {
    const c = this.contact;
    if (!c || fingers.length) return;
    this.contact = null;
    this.timers.clear(c.holdTimer);
    if (c.held || c.moved || now - c.t0 >= TAP_MS) return;
    const first = [...c.start.values()][0];
    if (c.most === 1) {
      if (c.onPage && !c.pencil) this.tap(1, now, first, "fingerDoubleTap", null);
    } else if (c.most === 2) this.tap(2, now, first, "twoDoubleTap", "twoTap");
    else this.emit(c.most === 3 ? "threeTap" : "fourTap");
  }

  /** A tap of `n` fingers: the double if one just came before, else the single, after a wait if the double is in use. */
  private tap(n: number, now: number, at: [number, number], double: GestureKind, single: GestureKind | null) {
    const p = this.pending;
    if (p && p.n === n && now - p.t < DOUBLE_MS && Math.hypot(at[0] - p.at[0], at[1] - p.at[1]) < DOUBLE_SLOP) {
      this.timers.clear(p.timer);
      this.pending = null;
      this.emit(double);
      return;
    }
    if (p) this.flush();
    if (!this.isBound(double)) {
      if (single) this.emit(single);
      return;
    }
    const timer = this.timers.set(() => this.flush(), DOUBLE_MS);
    this.pending = { n, t: now, at, timer };
  }

  /** Fires the single tap that waited to see whether a double would follow. */
  private flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.timers.clear(p.timer);
    if (p.n === 2) this.emit("twoTap");
  }

  /** The system took the touches (touchcancel): whatever they were doing counts for nothing. */
  cancel() {
    if (this.contact) this.timers.clear(this.contact.holdTimer);
    this.contact = null;
  }

  dispose() {
    if (this.contact) this.timers.clear(this.contact.holdTimer);
    if (this.pending) this.timers.clear(this.pending.timer);
    this.contact = this.pending = null;
  }
}
