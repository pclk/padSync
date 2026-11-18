import {
  LIMITATIONS,
  MODIFIERS,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  SAMPLE_FIELDS,
  TOUCH_FIELDS,
  type Capabilities,
  type FieldStatus,
  type MarkerRecord,
  type PencilRecording,
  type PointerRecord,
  type RecordedEvent,
  type RecordingEnvironment,
  type RecordingStats,
  type RecordingTool,
  type SampleField,
  type SampleTuple,
  type TargetKind,
  type TouchRecord,
  type TouchTuple,
  type TransformSnapshot,
} from "./schema";

// The recorder: takes pointer and touch events (or anything shaped like them) and keeps them, in
// order, as schema records. It knows nothing about the DOM wiring (capture.ts) or the page that
// shows it; it only copies what each event exposes. Nothing is filtered, rounded or smoothed.

/** The subset of a PointerEvent the recorder reads. Missing properties are recorded as null. */
export interface PointerLike {
  type: string;
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  isPrimary?: boolean;
  isTrusted?: boolean;
  cancelable?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  persistentDeviceId?: number;
  getCoalescedEvents?: () => ArrayLike<object>;
  getPredictedEvents?: () => ArrayLike<object>;
}

export interface TouchLike {
  type: string;
  timeStamp: number;
  isTrusted?: boolean;
  cancelable?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  changedTouches: ArrayLike<object>;
  touches: ArrayLike<{ identifier: number }>;
}

export type TransformInput = Omit<TransformSnapshot, "id">;

export interface StartOptions {
  id: string;
  createdAt: string;
  timeOrigin: number;
  now: number;
  environment: RecordingEnvironment;
  apis: Record<string, boolean>;
  tool: RecordingTool;
  transform: TransformInput;
  label?: string;
  expectedText?: string;
}

export type RecorderState = "idle" | "recording" | "stopped";

/** The most recent observed sample, for live feedback. */
export interface LastSample {
  type: string;
  pointerType: string;
  pointerId: number;
  values: Partial<Record<SampleField, number | null>>;
}

/** Keeps a recording to a size a phone browser can hold and save (~100–200 MB of JSON at most). */
export const MAX_EVENTS = 150_000;
export const MAX_SAMPLES = 1_000_000;

export const NOT_EXPOSED = [
  "Pencil hover height above the screen (pages get a hover position at most, as pointer events with no buttons)",
  "Squeeze and double-tap gestures; barrel roll only where the browser maps it to twist (see capabilities)",
  "Raw digitizer reports and sensor noise; UIKit's later corrections to estimated force and angles",
  "Hardware timestamps and the stylus's own sample rate: only what reaches the page is visible",
  "Contacts the OS took for its own gestures before the page saw them",
];

interface FieldAcc {
  present: number;
  min: number;
  max: number;
}

function newAcc(): Record<SampleField, FieldAcc> {
  return Object.fromEntries(SAMPLE_FIELDS.map((f) => [f, { present: 0, min: Infinity, max: -Infinity }])) as Record<SampleField, FieldAcc>;
}

const value = (o: object, key: string): number | null => {
  const v = (o as Record<string, unknown>)[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
};

export function sampleOf(o: object): SampleTuple {
  return SAMPLE_FIELDS.map((f) => value(o, f));
}

export function touchOf(o: object): TouchTuple {
  return TOUCH_FIELDS.map((f) => {
    if (f !== "touchType") return value(o, f);
    const t = (o as { touchType?: unknown }).touchType;
    return t === "stylus" ? 1 : t === "direct" ? 0 : null;
  });
}

function modifiers(e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
  return (e.altKey ? MODIFIERS.alt : 0) | (e.ctrlKey ? MODIFIERS.ctrl : 0) | (e.metaKey ? MODIFIERS.meta : 0) | (e.shiftKey ? MODIFIERS.shift : 0);
}

/** A list method a browser may not have, or may throw from outside dispatch. */
function list(fn: (() => ArrayLike<object>) | undefined, self: object): SampleTuple[] | null {
  if (typeof fn !== "function") return null;
  try {
    return Array.from(fn.call(self), sampleOf);
  } catch {
    return null;
  }
}

const sameTransform = (a: TransformInput, b: TransformInput) => JSON.stringify(a) === JSON.stringify(b);

const T = SAMPLE_FIELDS.indexOf("timeStamp");
const BUTTONS = SAMPLE_FIELDS.indexOf("buttons");

export class PencilRecorder {
  state: RecorderState = "idle";
  /** Bumped on every change, so a view can poll cheaply. */
  version = 0;
  last: LastSample | null = null;

  private opts: StartOptions | null = null;
  private events: RecordedEvent[] = [];
  private transforms: TransformSnapshot[] = [];
  private seq = 0;
  private samples = 0;
  private stopT: number | null = null;
  private truncated = false;
  private counts = { pointer: 0, touch: 0, marker: 0, coalesced: 0, predicted: 0, strokes: 0, cancels: 0 };
  private byType: Record<string, number> = {};
  private byPointerType: Record<string, number> = {};
  private fields: Record<string, { events: number; samples: number; acc: Record<SampleField, FieldAcc> }> = {};
  private stylusTouchSeen = false;
  private lastPenT = new Map<number, number>();
  private penIntervals: number[] = [];

  get recording() {
    return this.state === "recording";
  }

  start(opts: StartOptions) {
    this.reset();
    this.opts = opts;
    this.state = "recording";
    this.marker("record-start", opts.now, opts.now, { label: opts.label ?? "" }, opts.transform);
  }

  stop(now: number) {
    if (this.state !== "recording") return;
    this.marker("record-stop", now, now, { truncated: this.truncated });
    this.stopT = now;
    this.state = "stopped";
    this.version++;
  }

  reset() {
    this.state = "idle";
    this.opts = null;
    this.events = [];
    this.transforms = [];
    this.seq = 0;
    this.samples = 0;
    this.stopT = null;
    this.truncated = false;
    this.counts = { pointer: 0, touch: 0, marker: 0, coalesced: 0, predicted: 0, strokes: 0, cancels: 0 };
    this.byType = {};
    this.byPointerType = {};
    this.fields = {};
    this.stylusTouchSeen = false;
    this.lastPenT.clear();
    this.penIntervals = [];
    this.last = null;
    this.version++;
  }

  /** Records a pointer event. Call synchronously inside its listener (coalesced lists are read now). */
  pointer(e: PointerLike, target: TargetKind, transform: TransformInput, recv: number) {
    if (!this.accepting()) return;
    const coalesced = list(e.getCoalescedEvents, e);
    const predicted = list(e.getPredictedEvents, e);
    const rec: PointerRecord = {
      kind: "pointer",
      seq: this.seq++,
      t: e.timeStamp,
      recv,
      type: e.type,
      target,
      transform: this.transformId(transform),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      isPrimary: !!e.isPrimary,
      persistentDeviceId: typeof e.persistentDeviceId === "number" ? e.persistentDeviceId : null,
      modifiers: modifiers(e),
      isTrusted: e.isTrusted !== false,
      cancelable: !!e.cancelable,
      sample: sampleOf(e),
      coalesced,
      predicted,
    };
    if (!this.push(rec, 1 + (coalesced?.length ?? 0) + (predicted?.length ?? 0))) return;
    this.counts.pointer++;
    this.counts.coalesced += coalesced?.length ?? 0;
    this.counts.predicted += predicted?.length ?? 0;
    this.byType[e.type] = (this.byType[e.type] ?? 0) + 1;
    this.byPointerType[e.pointerType] = (this.byPointerType[e.pointerType] ?? 0) + 1;
    if (e.type === "pointerdown" && target === "surface" && e.pointerType !== "touch") this.counts.strokes++;
    if (e.type === "pointercancel") this.counts.cancels++;

    // Field statistics and feedback cover observed samples only: the dispatched event and its
    // coalesced samples (which usually include it), never predictions.
    const observed = coalesced?.length ? coalesced : [rec.sample];
    const f = (this.fields[e.pointerType] ??= { events: 0, samples: 0, acc: newAcc() });
    f.events++;
    for (const s of observed) {
      f.samples++;
      SAMPLE_FIELDS.forEach((name, i) => {
        const v = s[i];
        if (v === null) return;
        const a = f.acc[name];
        a.present++;
        if (v < a.min) a.min = v;
        if (v > a.max) a.max = v;
      });
      if (e.pointerType === "pen" && (e.type === "pointermove" || e.type === "pointerrawupdate")) this.penInterval(e.pointerId, s);
    }
    if (e.type === "pointerup" || e.type === "pointercancel") this.lastPenT.delete(e.pointerId);
    this.last = { type: e.type, pointerType: e.pointerType, pointerId: e.pointerId, values: Object.fromEntries(SAMPLE_FIELDS.map((n, i) => [n, rec.sample[i]])) };
  }

  touch(e: TouchLike, target: TargetKind, transform: TransformInput, recv: number) {
    if (!this.accepting()) return;
    const changed = Array.from(e.changedTouches, touchOf);
    const rec: TouchRecord = {
      kind: "touch",
      seq: this.seq++,
      t: e.timeStamp,
      recv,
      type: e.type,
      target,
      transform: this.transformId(transform),
      modifiers: modifiers(e),
      isTrusted: e.isTrusted !== false,
      cancelable: !!e.cancelable,
      changed,
      active: Array.from(e.touches, (t) => t.identifier),
    };
    if (!this.push(rec, changed.length)) return;
    this.counts.touch++;
    this.byType[e.type] = (this.byType[e.type] ?? 0) + 1;
    if (changed.some((c) => c[1] === 1)) this.stylusTouchSeen = true;
  }

  /** Page lifecycle and app markers (visibility, focus, resize, scroll, surface reset). */
  marker(type: string, t: number, recv: number, detail: MarkerRecord["detail"] = {}, transform?: TransformInput) {
    if (!this.accepting()) return;
    const rec: MarkerRecord = { kind: "marker", seq: this.seq++, t, recv, type, transform: transform ? this.transformId(transform) : null, detail };
    if (this.push(rec, 0)) this.counts.marker++;
  }

  stats(now?: number): RecordingStats {
    const iv = [...this.penIntervals].sort((a, b) => a - b);
    const start = this.opts?.now ?? 0;
    const end = this.stopT ?? now ?? start;
    return {
      events: this.events.length,
      pointerEvents: this.counts.pointer,
      touchEvents: this.counts.touch,
      markers: this.counts.marker,
      coalescedSamples: this.counts.coalesced,
      predictedSamples: this.counts.predicted,
      strokes: this.counts.strokes,
      cancels: this.counts.cancels,
      byType: { ...this.byType },
      byPointerType: { ...this.byPointerType },
      penIntervalMs: iv.length >= 8 ? iv[Math.floor(iv.length / 2)] : null,
      durationMs: this.opts ? Math.max(0, end - start) : 0,
    };
  }

  capabilities(): Capabilities {
    const pointerTypes: Capabilities["pointerTypes"] = {};
    for (const [type, f] of Object.entries(this.fields)) {
      const fields = {} as Record<SampleField, FieldStatus>;
      for (const name of SAMPLE_FIELDS) {
        const a = f.acc[name];
        fields[name] = !a.present ? { status: "unavailable" } : a.min === a.max ? { status: "constant", value: a.min } : { status: "varies", min: a.min, max: a.max };
      }
      pointerTypes[type] = { events: f.events, samples: f.samples, fields };
    }
    const pen = pointerTypes.pen;
    return {
      apis: { ...(this.opts?.apis ?? {}) },
      pointerTypes,
      stylusTouchSeen: this.stylusTouchSeen,
      penUnavailable: pen ? SAMPLE_FIELDS.filter((n) => pen.fields[n].status === "unavailable") : [],
      notExposed: [...NOT_EXPOSED],
    };
  }

  isTruncated() {
    return this.truncated;
  }

  /** The recording so far (or the finished one), as the serializable schema object. */
  toRecording(now?: number): PencilRecording {
    const o = this.opts;
    if (!o) throw new Error("Nothing recorded");
    return {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      id: o.id,
      createdAt: o.createdAt,
      timeOrigin: o.timeOrigin,
      startT: o.now,
      stopT: this.stopT,
      label: o.label ?? "",
      expectedText: o.expectedText ?? "",
      app: { name: "padsync", surface: "pencil-test" },
      environment: o.environment,
      tool: o.tool,
      sampleFields: [...SAMPLE_FIELDS],
      touchFields: [...TOUCH_FIELDS],
      transforms: this.transforms.slice(),
      events: this.events.slice(),
      capabilities: this.capabilities(),
      stats: this.stats(now),
      truncated: this.truncated,
      limitations: [...LIMITATIONS],
    };
  }

  private accepting() {
    return this.state === "recording" && !this.truncated;
  }

  private push(rec: RecordedEvent, samples: number): boolean {
    this.version++;
    if (this.events.length >= MAX_EVENTS || this.samples + samples > MAX_SAMPLES) {
      this.truncated = true;
      return false;
    }
    this.events.push(rec);
    this.samples += samples;
    return true;
  }

  private transformId(t: TransformInput): number {
    const last = this.transforms[this.transforms.length - 1];
    if (last) {
      const { id, ...rest } = last;
      if (sameTransform(rest, t)) return id;
    }
    const id = this.transforms.length;
    this.transforms.push({ id, ...t });
    return id;
  }

  private penInterval(pointerId: number, s: SampleTuple) {
    const t = s[T];
    if (t === null || !s[BUTTONS]) return;
    const prev = this.lastPenT.get(pointerId);
    this.lastPenT.set(pointerId, t);
    if (prev === undefined || t <= prev) return;
    this.penIntervals.push(t - prev);
    if (this.penIntervals.length > 4000) this.penIntervals.splice(0, 2000);
  }
}
