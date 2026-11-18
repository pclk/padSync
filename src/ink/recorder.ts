import { PAGE_WIDTH, type StrokeData } from "@/lib/types";
import type { InkPointer, InputKind, SectionHandle, ToolState } from "./controller";
import {
  MAX_EVENTS,
  MAX_SAMPLES_PER_EVENT,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  type CommittedStroke,
  type PencilRecording,
  type RecordedEvent,
  type RecordedSample,
} from "./recording";

// Captures the input reaching an InkController (its onInput/onCommit callbacks) as a
// PencilRecording. Values are copied off the events untouched; nothing is rounded here.

type PointerLike = InkPointer & Partial<Pick<PointerEvent, "tiltX" | "tiltY" | "twist" | "width" | "height" | "tangentialPressure">>;

const OPTIONAL = ["altitudeAngle", "azimuthAngle", "tiltX", "tiltY", "twist", "width", "height", "tangentialPressure"] as const;

export function sampleOf(e: PointerLike): RecordedSample {
  const s: RecordedSample = { timeStamp: e.timeStamp, clientX: e.clientX, clientY: e.clientY, pressure: e.pressure };
  for (const k of OPTIONAL) {
    const v = e[k];
    if (typeof v === "number" && Number.isFinite(v)) s[k] = v;
  }
  return s;
}

const DOM_TYPES = new Set(["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]);

export interface RecorderOptions {
  label?: string;
  source?: PencilRecording["source"];
  /** The controller's current tool and zoom, read on every event. */
  state: () => { tool: ToolState; zoom: number };
}

export class PencilRecorder {
  private events: RecordedEvent[] = [];
  private committed: CommittedStroke[] = [];
  private sections = new Map<string, { id: string; width: number; height: number }>();
  private lastTool: ToolState | null = null;
  private createdAt = new Date().toISOString();
  /** Set once the event limit is reached; the rest of the input is not kept. */
  truncated = false;

  constructor(private opts: RecorderOptions) {}

  get size() {
    return this.events.length;
  }

  get strokes() {
    return this.committed.length;
  }

  /** ControllerCallbacks.onInput */
  input = (kind: InputKind, e: InkPointer, sec: SectionHandle) => {
    // Fingers are kept too (the controller rejects them, which is worth testing).
    if (!DOM_TYPES.has(e.type)) return;
    if (this.events.length >= MAX_EVENTS) {
      this.truncated = true;
      return;
    }
    const r = sec.el.getBoundingClientRect();
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    const { tool, zoom } = this.opts.state();
    if (!this.sections.has(sec.id)) this.sections.set(sec.id, { id: sec.id, width: rect.width / zoom, height: rect.height / zoom });
    const ev: RecordedEvent = {
      seq: this.events.length,
      kind,
      type: e.type,
      section: sec.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      buttons: e.buttons,
      rect,
      zoom,
      sample: sampleOf(e),
    };
    if (e.type === "pointermove") {
      const co = e.getCoalescedEvents?.() ?? [];
      if (co.length) ev.coalesced = co.slice(0, MAX_SAMPLES_PER_EVENT).map(sampleOf);
      const pr = e.getPredictedEvents?.() ?? [];
      if (pr.length) ev.predicted = pr.slice(0, MAX_SAMPLES_PER_EVENT).map(sampleOf);
    }
    if (tool !== this.lastTool) {
      ev.tool = JSON.parse(JSON.stringify(tool)) as ToolState;
      this.lastTool = tool;
    }
    this.events.push(ev);
  };

  /** ControllerCallbacks.onCommit */
  commit = (sectionId: string, data: StrokeData) => {
    if (!this.events.length) return;
    this.committed.push({ afterSeq: this.events.length - 1, sectionId, data: JSON.parse(JSON.stringify(data)) as StrokeData });
  };

  finish(notes?: string): PencilRecording {
    const nav = typeof navigator === "undefined" ? null : navigator;
    const win = typeof window === "undefined" ? null : window;
    return {
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      id: `rec-${this.createdAt.replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`,
      label: this.opts.label ?? "Pencil recording",
      ...(notes ? { notes } : {}),
      createdAt: this.createdAt,
      source: this.opts.source ?? "device",
      environment: {
        userAgent: nav?.userAgent ?? "",
        platform: nav?.platform,
        maxTouchPoints: nav?.maxTouchPoints,
        devicePixelRatio: win?.devicePixelRatio ?? 1,
        viewport: { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 },
      },
      pageWidth: PAGE_WIDTH,
      timeOrigin: this.events[0]?.sample.timeStamp ?? 0,
      sections: [...this.sections.values()],
      events: this.events.slice(),
      committed: this.committed.slice(),
    };
  }
}
