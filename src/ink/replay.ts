import type { StrokeData } from "@/lib/types";
import type { InkController, InkPointer, SectionHandle, ToolState } from "./controller";
import type { PencilRecording, RecordedEvent, RecordedSample } from "./recording";

// Replays a PencilRecording through an InkController, the same entry points (down/move/up/
// lostCapture/grab) the section's pointer handlers call. Events are plain objects built from the
// recording, not synthetic DOM events, and the recording itself is only read. Playback follows the
// recorded timing (at a chosen speed) or is stepped one event at a time for tests.

export type ReplayController = Pick<InkController, "down" | "move" | "up" | "lostCapture" | "grab" | "configure" | "zoom" | "tool">;

export interface ReplayHost {
  /** The controller to feed; read on every event, so reset() may swap in a fresh one. */
  controller(): ReplayController;
  /** The live section a recorded section id plays onto (null skips its events). */
  section(id: string): SectionHandle | null;
  /** Called by restart(): drop everything the previous run drew, start a fresh controller. */
  reset(): void;
}

export interface Scheduler {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ReplayOptions {
  /**
   * "section" (default) maps samples onto the live section's current position and zoom, keeping
   * section coordinates; "client" passes the recorded client coordinates unchanged.
   */
  coordinates?: "section" | "client";
  /** Apply the tool recorded with the events (default true); false keeps the host's tool. */
  applyTool?: boolean;
  scheduler?: Scheduler;
  /** Called after every dispatch and state change (UI refresh). */
  onChange?: () => void;
}

export type ReplayState = "ready" | "playing" | "paused" | "done";

type Mapper = (s: RecordedSample) => [number, number];
const identity: Mapper = (s) => [s.clientX, s.clientY];

/** The live pointer for one recorded sample, with the event's pointer fields. */
function pointer(e: RecordedEvent, s: RecordedSample, map: Mapper, coalesced?: InkPointer[], predicted?: InkPointer[]): InkPointer {
  const [clientX, clientY] = map(s);
  return {
    type: e.type,
    pointerType: e.pointerType,
    pointerId: e.pointerId,
    button: e.button,
    buttons: e.buttons,
    clientX,
    clientY,
    pressure: s.pressure,
    timeStamp: s.timeStamp,
    altitudeAngle: s.altitudeAngle,
    azimuthAngle: s.azimuthAngle,
    preventDefault() {},
    getCoalescedEvents: () => coalesced ?? [],
    getPredictedEvents: () => predicted ?? [],
  };
}

export class PencilReplayer {
  readonly recording: PencilRecording;
  private host: ReplayHost;
  private opts: ReplayOptions;
  private sched: Scheduler;
  /** Playback time of each event: its offset from timeOrigin, never earlier than the one before. */
  private due: number[];
  private next = 0;
  private playhead = 0;
  private speedValue = 1;
  private anchor = 0;
  private timer: unknown = null;
  private waitingFor = 0;
  private frames = new Map<number, Mapper>();
  private stateValue: ReplayState = "ready";
  /** Events whose section the host couldn't place. */
  skipped = 0;

  constructor(recording: PencilRecording, host: ReplayHost, opts: ReplayOptions = {}) {
    this.recording = recording;
    this.host = host;
    this.opts = opts;
    this.sched = opts.scheduler ?? realScheduler;
    let t = 0;
    this.due = recording.events.map((e) => (t = Math.max(t, e.sample.timeStamp - recording.timeOrigin)));
  }

  get state() {
    return this.stateValue;
  }
  /** Index of the next event to dispatch. */
  get position() {
    return this.next;
  }
  get length() {
    return this.recording.events.length;
  }
  /** ms into the recording. */
  get time() {
    return this.playhead;
  }
  get duration() {
    return this.due.length ? this.due[this.due.length - 1] : 0;
  }
  get speed() {
    return this.speedValue;
  }

  /** The StrokeData.t0 a stroke started at this event would have had: deterministic per run. */
  clock = () => Date.parse(this.recording.createdAt) + Math.round(this.due[Math.max(0, this.next - 1)] ?? 0);

  /** Dispatches the next event. Returns it, or null at the end. */
  step(): RecordedEvent | null {
    if (this.next >= this.length) return null;
    const e = this.recording.events[this.next];
    this.playhead = this.due[this.next];
    this.next++;
    this.dispatch(e);
    if (this.next >= this.length) this.finish();
    else this.opts.onChange?.();
    return e;
  }

  /** Dispatches every event due at or before `ms` into the recording. */
  stepTo(ms: number) {
    while (this.next < this.length && this.due[this.next] <= ms) this.step();
    if (this.next < this.length) this.playhead = Math.max(this.playhead, Math.min(ms, this.due[this.next]));
  }

  /** Dispatches everything left, synchronously. */
  runToEnd() {
    this.pause();
    while (this.step());
  }

  play() {
    if (this.stateValue === "playing") return;
    if (this.next >= this.length) this.restart();
    this.stateValue = "playing";
    this.anchor = this.sched.now() - this.playhead / this.speedValue;
    this.waitingFor = 0;
    this.opts.onChange?.();
    this.tick();
  }

  pause() {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
    if (this.stateValue === "playing") {
      this.stateValue = "paused";
      this.opts.onChange?.();
    }
  }

  setSpeed(speed: number) {
    if (!(speed > 0) || !Number.isFinite(speed)) throw new Error(`speed must be a positive number, got ${speed}`);
    this.speedValue = speed;
    if (this.stateValue === "playing") {
      this.anchor = this.sched.now() - this.playhead / speed;
      this.waitingFor = 0;
      if (this.timer !== null) this.sched.clear(this.timer);
      this.tick();
    }
    this.opts.onChange?.();
  }

  /** Back to the start with a fresh controller and nothing drawn (host.reset). */
  restart() {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
    this.next = 0;
    this.playhead = 0;
    this.frames.clear();
    this.skipped = 0;
    this.stateValue = "ready";
    this.host.reset();
    this.opts.onChange?.();
  }

  /** Stops the timer for good (unmount). */
  dispose() {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
  }

  private tick = () => {
    this.timer = null;
    if (this.stateValue !== "playing") return;
    // The timer was set for the next event's time; rounding in now() - anchor must not leave it
    // just short, or the timer re-arms for ~0 ms forever.
    this.stepTo(Math.max((this.sched.now() - this.anchor) * this.speedValue, this.waitingFor));
    if (this.stateValue !== "playing" || this.next >= this.length) return;
    this.waitingFor = this.due[this.next];
    const wait = Math.max(0, (this.waitingFor - this.playhead) / this.speedValue);
    this.timer = this.sched.set(this.tick, wait);
  };

  private finish() {
    if (this.timer !== null) this.sched.clear(this.timer);
    this.timer = null;
    this.stateValue = "done";
    this.opts.onChange?.();
  }

  /** Client coordinates for this gesture: fixed at its down, as the controller fixes its rect then. */
  private mapper(e: RecordedEvent, sec: SectionHandle, zoom: number): Mapper {
    if (this.opts.coordinates === "client") return identity;
    const r = sec.el.getBoundingClientRect();
    if (r.left === e.rect.left && r.top === e.rect.top && zoom === e.zoom) return identity;
    const k = zoom / e.zoom;
    return (s) => [r.left + (s.clientX - e.rect.left) * k, r.top + (s.clientY - e.rect.top) * k];
  }

  private dispatch(e: RecordedEvent) {
    const sec = this.host.section(e.section);
    if (!sec) {
      this.skipped++;
      return;
    }
    const c = this.host.controller();
    if (e.tool && this.opts.applyTool !== false) c.configure(e.tool as ToolState, c.zoom);
    const starts = e.type === "pointerdown";
    let map = starts ? undefined : this.frames.get(e.pointerId);
    if (!map) {
      map = this.mapper(e, sec, c.zoom);
      // A hover (no buttons) or the end of a gesture doesn't hold a frame.
      if (starts || e.buttons) this.frames.set(e.pointerId, map);
    }
    const m = map;
    const p = pointer(
      e,
      e.sample,
      m,
      e.coalesced?.map((s) => pointer(e, s, m)),
      e.predicted?.map((s) => pointer(e, s, m)),
    );
    if (e.kind === "down") c.down(p, sec);
    else if (e.kind === "move") c.move(p, sec);
    else if (e.kind === "up") c.up(p, sec);
    else if (e.kind === "lost") c.lostCapture(p, sec);
    else if (e.kind === "grab") c.grab(p, sec, { setPointerCapture() {} });
    if (e.kind === "up" || e.kind === "lost") this.frames.delete(e.pointerId);
  }
}

export interface ReplayedStroke {
  sectionId: string;
  data: StrokeData;
  /** Index of the event whose dispatch committed it. */
  afterSeq: number;
}

/** Differences between committed strokes, ignoring t0 and device (wall clock and machine). */
export function diffStrokes(expected: { sectionId: string; data: StrokeData }[], actual: { sectionId: string; data: StrokeData }[]): string[] {
  const out: string[] = [];
  if (expected.length !== actual.length) out.push(`stroke count: expected ${expected.length}, got ${actual.length}`);
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n && out.length < 20; i++) {
    const a = expected[i];
    const b = actual[i];
    if (a.sectionId !== b.sectionId) out.push(`stroke ${i}: section ${a.sectionId} vs ${b.sectionId}`);
    for (const k of ["tool", "color", "size", "input"] as const) if (a.data[k] !== b.data[k]) out.push(`stroke ${i}: ${k} ${a.data[k]} vs ${b.data[k]}`);
    if (JSON.stringify(a.data.pen ?? {}) !== JSON.stringify(b.data.pen ?? {})) out.push(`stroke ${i}: pen params differ`);
    const pa = a.data.pts;
    const pb = b.data.pts;
    if (pa.length !== pb.length) out.push(`stroke ${i}: ${pa.length / 6} points vs ${pb.length / 6}`);
    else {
      const j = pa.findIndex((v, k) => v !== pb[k]);
      if (j >= 0) out.push(`stroke ${i}: point ${Math.floor(j / 6)} field ${j % 6} is ${pa[j]} vs ${pb[j]}`);
    }
  }
  return out;
}
