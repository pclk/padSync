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
  | "resetZoom"
  /** Chat prompts in a circle: around a tap to be tapped, or around a held finger to point into. */
  | "promptMenu"
  /** Press and hold only: the held finger draws a lasso, and lifting it selects what it circled. */
  | "lassoHold";

export type GestureBindings = Record<GestureKind, GestureAction>;

export const GESTURES: { kind: GestureKind; label: string; hint: string }[] = [
  { kind: "twoTap", label: "Two-finger tap", hint: "Tap two fingers anywhere." },
  { kind: "threeTap", label: "Three-finger tap", hint: "Tap three fingers anywhere." },
  { kind: "fourTap", label: "Four-finger tap", hint: "Tap four fingers anywhere. Turn off iPadOS multitasking gestures if the system takes it." },
  { kind: "twoDoubleTap", label: "Two-finger double tap", hint: "Tap two fingers twice. While this is set, a two-finger tap waits a moment to see whether a second one follows." },
  { kind: "fingerDoubleTap", label: "Finger double tap", hint: "Tap one finger twice on the page." },
  { kind: "fingerHold", label: "Finger press and hold", hint: "Hold one finger still on the page until the ring under it fills. How long and how still are under Fine-tune." },
];

/** `only`: the gestures an action makes sense for (all when absent). */
export const GESTURE_ACTIONS: { action: GestureAction; label: string; only?: GestureKind[] }[] = [
  { action: "none", label: "Nothing" },
  { action: "lassoHold", label: "Lasso while held", only: ["fingerHold"] },
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
  { action: "promptMenu", label: "Prompt menu" },
];

export const GESTURES_KEY = "padsync.gestures";
/** Two fingers undo and three redo, as before gestures could be changed; holding a finger lassoes. */
export const DEFAULT_GESTURES: GestureBindings = {
  twoTap: "undo",
  threeTap: "redo",
  fourTap: "none",
  twoDoubleTap: "none",
  fingerDoubleTap: "none",
  fingerHold: "lassoHold",
};

export const actionsFor = (g: GestureKind) => GESTURE_ACTIONS.filter((a) => !a.only || a.only.includes(g));
const isActionFor = (g: GestureKind, v: unknown): v is GestureAction => actionsFor(g).some((a) => a.action === v);

export function normalizeGestures(raw: Partial<GestureBindings> | null | undefined): GestureBindings {
  const out = { ...DEFAULT_GESTURES };
  for (const g of GESTURES) {
    const v = raw?.[g.kind];
    if (isActionFor(g.kind, v)) out[g.kind] = v;
  }
  return out;
}

export const actionLabel = (a: GestureAction) => GESTURE_ACTIONS.find((x) => x.action === a)?.label ?? a;

/** How the gestures are told apart, adjustable under Settings → Touch gestures → Fine-tune. */
export interface GestureTuning {
  /** Lift within this long, without moving, and it was a tap (ms). */
  tapMs: number;
  /** A second tap within this long makes a double tap (ms). */
  doubleMs: number;
  /** Hold one finger still this long and it is a press and hold (ms). */
  holdMs: number;
  /** How far a finger may drift and still be a tap or a hold (px). */
  slop: number;
  /** One-finger gestures are ignored this soon after the Pencil, so a resting palm triggers nothing (ms). */
  pencilQuietMs: number;
  /** Show a short note of what each gesture did. */
  showNote: boolean;
}

export const DEFAULT_TUNING: GestureTuning = { tapMs: 280, doubleMs: 300, holdMs: 250, slop: 10, pencilQuietMs: 800, showNote: true };

/** The range and step of each numeric tuning, for the sliders and for clamping stored values. */
export const TUNING_RANGES: Record<Exclude<keyof GestureTuning, "showNote">, { min: number; max: number; step: number; unit: string; label: string; hint: string }> = {
  holdMs: { min: 200, max: 1500, step: 50, unit: "ms", label: "Hold time", hint: "How long to hold a finger before press and hold (and the lasso) starts." },
  slop: { min: 4, max: 30, step: 1, unit: "px", label: "Stillness", hint: "How far a finger may drift during a tap or hold. Past about 10 px the page may start scrolling first." },
  tapMs: { min: 120, max: 500, step: 10, unit: "ms", label: "Tap length", hint: "The longest press that still counts as a tap." },
  doubleMs: { min: 150, max: 600, step: 10, unit: "ms", label: "Double-tap speed", hint: "How soon the second tap must follow. Also how long a two-finger tap waits while its double is set." },
  pencilQuietMs: { min: 0, max: 2000, step: 50, unit: "ms", label: "Palm guard", hint: "One-finger gestures are ignored this long after the Pencil touches." },
};

export const GESTURE_TUNING_KEY = "padsync.gestureTuning";

export function normalizeTuning(raw: Partial<GestureTuning> | null | undefined): GestureTuning {
  const out = { ...DEFAULT_TUNING };
  for (const [k, r] of Object.entries(TUNING_RANGES) as [keyof typeof TUNING_RANGES, (typeof TUNING_RANGES)[keyof typeof TUNING_RANGES]][]) {
    const v = raw?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(r.max, Math.max(r.min, v));
  }
  if (typeof raw?.showNote === "boolean") out.showNote = raw.showNote;
  return out;
}

/** A second tap must land this close to the first to make a double tap. */
export const DOUBLE_SLOP = 40;

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

/** Where a gesture happened: the first finger's id and where it pressed. */
export interface GestureAt {
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
  first: GestureAt;
  /** One-finger gestures only count on the page itself, not on controls or a text box. */
  onPage: boolean;
  /** The Pencil was in use: one-finger gestures are off for this contact. */
  pencil: boolean;
  held: boolean;
  holdTimer: unknown;
}

export interface RecognizerOptions {
  emit: (g: GestureKind, at: GestureAt) => void;
  isBound: (g: GestureKind) => boolean;
  tuning?: () => GestureTuning;
  /** A press and hold is counting down ("start", at the finger) or stopped short of it ("stop"). */
  onHold?: (state: "start" | "stop", at: GestureAt) => void;
  onPageTap?: () => void;
  timers?: Timers;
}

/**
 * Turns finger touches into gestures. Call `start`, `move` and `end` with the fingers down after
 * each touch event (Pencil touches left out) and `pencil` whenever the Pencil touches.
 */
export class GestureRecognizer {
  private contact: Contact | null = null;
  private lastPencil = -Infinity;
  /** A tap that might become a double tap: what it was, when, where, and the pending single. */
  private pending: { n: number; t: number; at: GestureAt; timer: unknown } | null = null;
  private emit: RecognizerOptions["emit"];
  private isBound: RecognizerOptions["isBound"];
  private tuning: () => GestureTuning;
  private onHold: NonNullable<RecognizerOptions["onHold"]>;
  private onPageTap: RecognizerOptions["onPageTap"];
  private timers: Timers;

  constructor(o: RecognizerOptions) {
    this.onPageTap = o.onPageTap;
    this.emit = o.emit;
    this.isBound = o.isBound;
    this.tuning = o.tuning ?? (() => DEFAULT_TUNING);
    this.onHold = o.onHold ?? (() => {});
    this.timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  /** Stops a hold that is counting down, telling onHold. */
  private stopHold(c: Contact) {
    if (c.holdTimer === null) return;
    this.timers.clear(c.holdTimer);
    c.holdTimer = null;
    this.onHold("stop", c.first);
  }

  pencil(now: number) {
    this.lastPencil = now;
    if (this.contact) {
      this.contact.pencil = true;
      this.stopHold(this.contact);
    }
  }

  start(fingers: TouchPoint[], now: number, onPage: boolean) {
    if (!fingers.length) return;
    const t = this.tuning();
    if (!this.contact) {
      const f = fingers[0];
      const c: Contact = {
        t0: now,
        most: 0,
        moved: false,
        start: new Map(),
        first: { id: f.id, x: f.x, y: f.y },
        onPage,
        pencil: now - this.lastPencil < t.pencilQuietMs,
        held: false,
        holdTimer: null,
      };
      this.contact = c;
      if (fingers.length === 1 && onPage && !c.pencil && this.isBound("fingerHold")) {
        c.holdTimer = this.timers.set(() => {
          c.holdTimer = null;
          if (this.contact !== c || c.moved || c.most !== 1 || c.pencil) return;
          c.held = true;
          this.emit("fingerHold", c.first);
        }, t.holdMs);
        this.onHold("start", c.first);
      }
    }
    const c = this.contact;
    for (const f of fingers) if (!c.start.has(f.id)) c.start.set(f.id, [f.x, f.y]);
    c.most = Math.max(c.most, fingers.length);
    if (c.most > 1) this.stopHold(c);
  }

  move(fingers: TouchPoint[]) {
    const c = this.contact;
    if (!c || c.moved || c.held) return;
    const slop = this.tuning().slop;
    c.moved = fingers.some((f) => {
      const s = c.start.get(f.id);
      return s && Math.hypot(f.x - s[0], f.y - s[1]) > slop;
    });
    if (c.moved) this.stopHold(c);
  }

  end(fingers: TouchPoint[], now: number) {
    const c = this.contact;
    if (!c || fingers.length) return;
    this.contact = null;
    this.stopHold(c);
    if (c.held || c.moved || now - c.t0 >= this.tuning().tapMs) return;
    if (c.most === 1) {
      if (c.onPage && !c.pencil) {
        this.onPageTap?.();
        this.tap(1, now, c.first, "fingerDoubleTap", null);
      }
    } else if (c.most === 2) this.tap(2, now, c.first, "twoDoubleTap", "twoTap");
    else this.emit(c.most === 3 ? "threeTap" : "fourTap", c.first);
  }

  /** A tap of `n` fingers: the double if one just came before, else the single, after a wait if the double is in use. */
  private tap(n: number, now: number, at: GestureAt, double: GestureKind, single: GestureKind | null) {
    const p = this.pending;
    const { doubleMs } = this.tuning();
    if (p && p.n === n && now - p.t < doubleMs && Math.hypot(at.x - p.at.x, at.y - p.at.y) < DOUBLE_SLOP) {
      this.timers.clear(p.timer);
      this.pending = null;
      this.emit(double, at);
      return;
    }
    if (p) this.flush();
    if (!this.isBound(double)) {
      if (single) this.emit(single, at);
      return;
    }
    const timer = this.timers.set(() => this.flush(), doubleMs);
    this.pending = { n, t: now, at, timer };
  }

  /** Fires the single tap that waited to see whether a double would follow. */
  private flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.timers.clear(p.timer);
    if (p.n === 2) this.emit("twoTap", p.at);
  }

  /** The system took the touches (touchcancel): whatever they were doing counts for nothing. */
  cancel() {
    if (this.contact) this.stopHold(this.contact);
    this.contact = null;
  }

  dispose() {
    this.cancel();
    if (this.pending) this.timers.clear(this.pending.timer);
    this.pending = null;
  }
}
