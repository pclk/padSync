import { InkController, type InkPointer, type SectionHandle, type ToolState } from "@/ink/controller";
import { PencilRecorder } from "@/ink/recorder";
import type { PencilRecording } from "@/ink/recording";

// SYNTHETIC Pencil input for tests. Nothing here came from an iPad: the samples are generated to
// look like what iPadOS Safari delivers for Apple Pencil (240 Hz samples coalesced into ~60 Hz
// pointermove events, a couple of predicted samples per move, a pressure ramp in and out,
// altitude/azimuth that drift), and are captured through the real controller + PencilRecorder so
// the file is exactly what the Pencil lab would save. Recordings made here are marked
// source: "synthetic" and their label starts with "SYNTHETIC". They test the pipeline's
// mechanics; only real recordings (docs/pencil-test-handoff.md) say anything about real writing.

export interface SynthStroke {
  /** Waypoints in section coordinates; the pen moves along them at an even pace. */
  path: [number, number][];
  durationMs: number;
  /** Pressure along the stroke, u in [0, 1]. Default: ramps in over 15%, out over 20%, peak 0.45. */
  pressure?: (u: number) => number;
  altitude?: (u: number) => number;
  azimuth?: (u: number) => number;
  /** How the gesture ends. "lost": lostpointercapture, then a late pointerup. "open": never ends. */
  end?: "up" | "cancel" | "lost" | "open";
  pointerType?: "pen" | "mouse" | "touch";
  pointerId?: number;
  /** Pause before this stroke, ms (pen hovering, so hover moves are sent). Default 180. */
  gapMs?: number;
  section?: string;
}

export interface SynthOptions {
  label: string;
  strokes: SynthStroke[];
  tool?: Partial<ToolState>;
  /** The section's client rect at capture (the page scrolled/zoomed so it sits here). */
  rect?: { left: number; top: number };
  zoom?: number;
  sampleHz?: number;
  frameHz?: number;
  predicted?: number;
  /** Include getCoalescedEvents() on moves (default true). */
  coalesced?: boolean;
  startTime?: number;
}

export const SYNTH_TOOL: ToolState = { kind: "pen", penColor: "#1e293b", penSize: 3, hlColor: "#fde047", hlSize: 20, eraserSize: 20 };

const ramp = (u: number) => 0.45 * Math.min(1, u / 0.15, (1 - u) / 0.2) + 0.03;

/** Even-paced position along a polyline, u in [0, 1]. */
function along(path: [number, number][], u: number): [number, number] {
  if (path.length === 1) return path[0];
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) total += seg[seg.push(Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])) - 1];
  let d = u * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const k = seg[i] ? Math.min(1, d / seg[i]) : 0;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k];
    }
    d -= seg[i];
  }
  return path[path.length - 1];
}

interface Sample {
  t: number;
  x: number;
  y: number;
  p: number;
  alt: number;
  az: number;
}

/** Generates a recording by driving a real InkController with a PencilRecorder attached. */
export function synthesize(o: SynthOptions): PencilRecording {
  const tool: ToolState = { ...SYNTH_TOOL, ...o.tool };
  const zoom = o.zoom ?? 1;
  const rect = { left: o.rect?.left ?? 40, top: o.rect?.top ?? 120 };
  const sampleHz = o.sampleHz ?? 240;
  const frameHz = o.frameHz ?? 60;
  const perFrame = Math.max(1, Math.round(sampleHz / frameHz));
  const predictN = o.predicted ?? 2;
  const withCoalesced = o.coalesced ?? true;
  const sectionIds = [...new Set(o.strokes.map((s) => s.section ?? "synthetic-section"))];
  const handles = new Map<string, SectionHandle>();
  sectionIds.forEach((id, i) => {
    // Sections stacked down the page, 700 units tall each.
    const top = rect.top + i * 700 * zoom;
    const r = { left: rect.left, top, width: 1376 * zoom, height: 700 * zoom, right: rect.left + 1376 * zoom, bottom: top + 700 * zoom, x: rect.left, y: top };
    handles.set(id, { id, el: { getBoundingClientRect: () => r, setPointerCapture() {} } as unknown as HTMLElement, strokes: () => [] });
  });

  const recorder = new PencilRecorder({ label: o.label.startsWith("SYNTHETIC") ? o.label : `SYNTHETIC: ${o.label}`, source: "synthetic", state: () => ({ tool, zoom }) });
  const controller = new InkController("synthetic", tool, { onSelection() {}, onDragging() {}, onTextCreate() {}, onInput: recorder.input, onCommit: recorder.commit }, { persist: false, now: () => 0, device: "synthetic" });
  controller.configure(tool, zoom);

  const client = (sec: SectionHandle, x: number, y: number): [number, number] => {
    const r = sec.el.getBoundingClientRect();
    return [r.left + x * zoom, r.top + y * zoom];
  };
  const ptr = (type: string, sec: SectionHandle, s: Sample, st: SynthStroke, buttons: number, coalesced?: InkPointer[], predicted?: InkPointer[]): InkPointer => {
    const [clientX, clientY] = client(sec, s.x, s.y);
    const pointerType = st.pointerType ?? "pen";
    return {
      type,
      pointerType,
      pointerId: st.pointerId ?? 2,
      button: type === "pointermove" ? -1 : 0,
      buttons,
      clientX,
      clientY,
      pressure: pointerType === "pen" ? s.p : buttons ? 0.5 : 0,
      timeStamp: s.t,
      altitudeAngle: s.alt,
      azimuthAngle: s.az,
      preventDefault() {},
      getCoalescedEvents: () => coalesced ?? [],
      getPredictedEvents: () => predicted ?? [],
    };
  };

  let t = o.startTime ?? 1000;
  for (const st of o.strokes) {
    const sec = handles.get(st.section ?? "synthetic-section")!;
    const pressure = st.pressure ?? ramp;
    const alt = st.altitude ?? ((u: number) => 0.95 + 0.1 * u);
    const az = st.azimuth ?? ((u: number) => 2.2 - 0.2 * u);
    const sample = (u: number, at: number): Sample => {
      const [x, y] = along(st.path, u);
      return { t: Math.round(at * 1000) / 1000, x, y, p: Math.round(pressure(u) * 1e4) / 1e4, alt: alt(u), az: az(u) };
    };
    // Hovering in from 30 units away before touching down (pen only: fingers don't hover).
    const gap = st.gapMs ?? 180;
    if ((st.pointerType ?? "pen") === "pen" && gap > 0) {
      const s0 = sample(0, t);
      for (let k = 3; k >= 1; k--) controller.move(ptr("pointermove", sec, { ...s0, y: s0.y - 10 * k, p: 0, t: t + (3 - k) * (gap / 4) }, st, 0), sec);
    }
    t += gap;
    const n = Math.max(1, Math.round((st.durationMs / 1000) * sampleHz));
    const samples = Array.from({ length: n + 1 }, (_, i) => sample(i / n, t + (i * 1000) / sampleHz));
    controller.down(ptr("pointerdown", sec, samples[0], st, 1), sec);
    for (let i = 1; i < samples.length; i += perFrame) {
      const group = samples.slice(i, i + perFrame);
      const last = group[group.length - 1];
      // The dispatched event is the newest sample; getCoalescedEvents() lists the frame's samples
      // including that one, as browsers do.
      const coalesced = withCoalesced ? group.map((s) => ptr("pointermove", sec, s, st, 1)) : undefined;
      // Predictions extrapolate the latest velocity, 2 samples apart: wrong at turns and the end,
      // as real ones are, so tests can check they never reach the stored stroke.
      const prev = samples[samples.indexOf(last) - 1] ?? last;
      const predicted = Array.from({ length: predictN }, (_, k) => {
        const ahead = (k + 1) * 2;
        return ptr("pointermove", sec, { ...last, t: last.t + (ahead * 1000) / sampleHz, x: last.x + (last.x - prev.x) * ahead, y: last.y + (last.y - prev.y) * ahead }, st, 1);
      });
      controller.move(ptr("pointermove", sec, last, st, 1, coalesced, predicted), sec);
    }
    const end = samples[samples.length - 1];
    const lift = { ...end, t: end.t + 4, p: 0 };
    if (st.end === "cancel") controller.up(ptr("pointercancel", sec, lift, st, 0), sec);
    else if (st.end === "lost") {
      controller.lostCapture(ptr("lostpointercapture", sec, lift, st, 0), sec);
      controller.up(ptr("pointerup", sec, { ...lift, t: lift.t + 3 }, st, 0), sec);
    } else if (st.end !== "open") controller.up(ptr("pointerup", sec, lift, st, 0), sec);
    t = lift.t;
  }
  controller.endGesture();
  const rec = recorder.finish();
  // Fixed identity and environment, so the same inputs always produce the same file.
  return {
    ...rec,
    id: `synthetic-${o.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    notes: "SYNTHETIC fixture generated by tests/helpers/synthetic-pencil.ts. Not recorded on a device.",
    environment: { userAgent: "synthetic (padSync test generator, no device)", platform: "synthetic", maxTouchPoints: 0, devicePixelRatio: 2, viewport: { width: 1376, height: 1032 } },
  };
}

/** Waypoints for handwriting-like letters, in a ~14-unit em box at (x, y). */
export function letterPaths(text: string, x: number, y: number): [number, number][][] {
  const glyphs: Record<string, [number, number][][]> = {
    h: [[[0, 0], [0, 14]], [[0, 8], [3, 6], [7, 7], [7, 14]]],
    i: [[[0, 6], [0, 14]], [[0, 2]]],
    l: [[[0, 0], [0, 14]]],
    o: [[[4, 6], [1, 8], [1, 12], [4, 14], [7, 12], [7, 8], [4, 6.2]]],
    a: [[[7, 7], [3, 6], [0, 10], [3, 14], [7, 11]], [[7, 6], [7, 14]]],
    t: [[[2, 1], [2, 14]], [[0, 6], [5, 6]]],
  };
  const out: [number, number][][] = [];
  let cx = x;
  for (const ch of text) {
    for (const g of glyphs[ch] ?? []) out.push(g.map(([gx, gy]) => [cx + gx * 2, y + gy * 2]));
    cx += ch === " " ? 16 : 22;
  }
  return out;
}
