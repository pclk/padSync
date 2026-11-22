import { getStroke } from "perfect-freehand";
import { STROKE_STRIDE, type StrokeData } from "@/lib/types";
import { InkController, type ToolState } from "./controller";
import type { PenParams } from "./pen-feel";
import { recordingDuration, type PencilRecording, type RecordedEvent } from "./recording";
import { PencilReplayer, diffStrokes, type ReplayedStroke } from "./replay";
import { dotCentre, strokeInput, strokeOptions, strokeSvgPath } from "./render";

// The programmatic replay harness: runs a recording through the real InkController (headless: no
// page, no store, no canvas) and the real render pipeline (toInput → perfect-freehand outline),
// and reports what came out as numbers a test or a coding assistant can compare between code
// versions. See docs/pencil-test-handoff.md.
//
// Two kinds of time appear here and must not be confused:
// - recorded timing (sample timeStamps, durations, sample intervals) is the browser's, from the
//   recording, and is deterministic;
// - `performance` is how long this process took to run the pipeline. It is CPU time on whatever
//   machine runs the test, NOT the touch-to-ink latency on the iPad, which a web page cannot
//   measure (it needs a high-speed camera or the display pipeline's own timing).

export const HARNESS_VERSION = 1;

export interface HarnessOptions {
  /** Replaces the recorded tool for the whole replay. */
  tool?: ToolState;
  /** Pen parameter overrides merged into every recorded (or given) tool: try a writing change. */
  pen?: Partial<PenParams>;
  /** Feed getCoalescedEvents() samples (default true). False: only the dispatched events. */
  useCoalesced?: boolean;
  /** Feed getPredictedEvents() samples (default true). They only affect the live preview. */
  usePredicted?: boolean;
  /** Put each stroke's SVG outline in the report (large; off by default). */
  includeSvg?: boolean;
}

interface Range {
  min: number;
  max: number;
}

export interface StrokeMetrics {
  index: number;
  sectionId: string;
  /** seq of the event whose dispatch committed the stroke. */
  afterSeq: number;
  tool: StrokeData["tool"];
  input: string;
  color: string;
  size: number;
  /** Stored points (STROKE_STRIDE values each), after the controller's de-duplication. */
  points: number;
  /** Last stored point's t (ms after the stroke's pointerdown). */
  durationMs: number;
  pressure: Range & { mean: number };
  altitude: Range;
  azimuth: Range;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** Polyline length of the stored points, section units. */
  rawLength: number;
  /** After render-time clean-up (toInput: trims, back-track drop, gap fill, smoothing). */
  processed: {
    points: number;
    length: number;
    /** How far the processed line starts/ends from the stored line's first/last point: a cut-off letter part shows up here. */
    startGap: number;
    endGap: number;
    /** Distance of processed points from the stored polyline: how much clean-up moved the line. */
    maxDeviation: number;
    meanDeviation: number;
  };
  outline: { kind: "dot" | "outline"; points: number; svg?: string };
}

export interface ReplayReport {
  harnessVersion: typeof HARNESS_VERSION;
  recording: {
    id: string;
    label: string;
    source: PencilRecording["source"];
    createdAt: string;
    userAgent: string;
    durationMs: number;
    sections: number;
    events: { total: number; byType: Record<string, number>; byPointerType: Record<string, number> };
    samples: { dispatched: number; coalesced: number; predicted: number };
    gestures: { downs: number; ups: number; cancels: number; lostCaptures: number };
    /** Median interval between consecutive observed pen samples while pressed, recorded ms. */
    penIntervalMs: number | null;
  };
  options: { useCoalesced: boolean; usePredicted: boolean; pen: Partial<PenParams> | null; toolOverride: boolean };
  strokes: StrokeMetrics[];
  /** Gestures the stray-dot filter threw away (bounces, resting tips). */
  discarded: { count: number; points: number[] };
  totals: { strokes: number; points: number; processedPoints: number; outlinePoints: number; rawLength: number; processedLength: number };
  /** Hash of every stored stroke (section, tool, colour, size, pen, points): equal ⇔ same ink. */
  fingerprint: string;
  /** Hash of every outline as drawn: catches render-only changes. */
  outlineFingerprint: string;
  /** Replay vs the strokes committed while recording (null when the file has none). */
  capture: { matches: boolean; differences: string[] } | null;
  /** Wall time in THIS process. Not touch-to-ink latency; varies by machine; never in baselines. */
  performance: { replayMs: number; renderMs: number; eventsPerMs: number; note: string };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** FNV-1a 32-bit over a string: a stable short fingerprint, no crypto dependency. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

function polylineLength(xy: number[][]): number {
  let len = 0;
  for (let i = 1; i < xy.length; i++) len += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  return len;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function deviation(processed: number[][], raw: number[][]): { max: number; mean: number } {
  if (!processed.length || !raw.length) return { max: 0, mean: 0 };
  let max = 0;
  let sum = 0;
  for (const [x, y] of processed) {
    let d = raw.length === 1 ? Math.hypot(x - raw[0][0], y - raw[0][1]) : Infinity;
    for (let i = 1; i < raw.length; i++) d = Math.min(d, distToSegment(x, y, raw[i - 1][0], raw[i - 1][1], raw[i][0], raw[i][1]));
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: sum / processed.length };
}

function range(values: number[]): Range {
  return { min: r3(Math.min(...values)), max: r3(Math.max(...values)) };
}

/** Metrics for one stored stroke, through the same render functions the page uses. */
export function strokeMetrics(s: ReplayedStroke, index: number, includeSvg = false): StrokeMetrics {
  const d = s.data;
  const raw: number[][] = [];
  const pressure: number[] = [];
  const altitude: number[] = [];
  const azimuth: number[] = [];
  for (let i = 0; i < d.pts.length; i += STROKE_STRIDE) {
    raw.push([d.pts[i], d.pts[i + 1]]);
    pressure.push(d.pts[i + 2]);
    altitude.push(d.pts[i + 3]);
    azimuth.push(d.pts[i + 4]);
  }
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const processed = strokeInput(d);
  const dev = deviation(processed, raw);
  const dot = dotCentre(d);
  const first = processed[0] ?? raw[0];
  const last = processed[processed.length - 1] ?? raw[raw.length - 1];
  const outlinePoints = dot ? 0 : getStroke(processed, strokeOptions(d, true)).length;
  return {
    index,
    sectionId: s.sectionId,
    afterSeq: s.afterSeq,
    tool: d.tool,
    input: d.input,
    color: d.color,
    size: d.size,
    points: raw.length,
    durationMs: d.pts[d.pts.length - 1] ?? 0,
    pressure: { ...range(pressure), mean: r3(pressure.reduce((a, b) => a + b, 0) / pressure.length) },
    altitude: range(altitude),
    azimuth: range(azimuth),
    box: { minX: r3(Math.min(...xs)), minY: r3(Math.min(...ys)), maxX: r3(Math.max(...xs)), maxY: r3(Math.max(...ys)) },
    rawLength: r3(polylineLength(raw)),
    processed: {
      points: processed.length,
      length: r3(polylineLength(processed)),
      startGap: r3(Math.hypot(first[0] - raw[0][0], first[1] - raw[0][1])),
      endGap: r3(Math.hypot(last[0] - raw[raw.length - 1][0], last[1] - raw[raw.length - 1][1])),
      maxDeviation: r3(dev.max),
      meanDeviation: r3(dev.mean),
    },
    outline: { kind: dot ? "dot" : "outline", points: outlinePoints, ...(includeSvg ? { svg: strokeSvgPath(d) } : {}) },
  };
}

/** Recording statistics that need no replay: what the browser delivered. */
export function recordingStats(rec: PencilRecording): ReplayReport["recording"] {
  const byType: Record<string, number> = {};
  const byPointerType: Record<string, number> = {};
  const samples = { dispatched: 0, coalesced: 0, predicted: 0 };
  const gestures = { downs: 0, ups: 0, cancels: 0, lostCaptures: 0 };
  const intervals: number[] = [];
  const lastPen = new Map<number, number>();
  for (const e of rec.events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    byPointerType[e.pointerType] = (byPointerType[e.pointerType] ?? 0) + 1;
    samples.dispatched++;
    samples.coalesced += e.coalesced?.length ?? 0;
    samples.predicted += e.predicted?.length ?? 0;
    if (e.type === "pointerdown") gestures.downs++;
    else if (e.type === "pointerup") gestures.ups++;
    else if (e.type === "pointercancel") gestures.cancels++;
    else if (e.type === "lostpointercapture") gestures.lostCaptures++;
    if (e.pointerType !== "pen") continue;
    if (e.type === "pointerdown") lastPen.set(e.pointerId, e.sample.timeStamp);
    else if (e.type === "pointermove" && e.buttons && lastPen.has(e.pointerId)) {
      for (const s of e.coalesced?.length ? e.coalesced : [e.sample]) {
        const prev = lastPen.get(e.pointerId)!;
        if (s.timeStamp > prev) intervals.push(s.timeStamp - prev);
        lastPen.set(e.pointerId, Math.max(prev, s.timeStamp));
      }
    } else if (e.type !== "pointermove") lastPen.delete(e.pointerId);
  }
  intervals.sort((a, b) => a - b);
  return {
    id: rec.id,
    label: rec.label,
    source: rec.source,
    createdAt: rec.createdAt,
    userAgent: rec.environment.userAgent,
    durationMs: r3(recordingDuration(rec)),
    sections: rec.sections.length,
    events: { total: rec.events.length, byType, byPointerType },
    samples,
    gestures,
    penIntervalMs: intervals.length ? r3(intervals[Math.floor(intervals.length / 2)]) : null,
  };
}

/** The recording as the harness options want it replayed; the original is never changed. */
function prepare(rec: PencilRecording, o: HarnessOptions): PencilRecording {
  const useCoalesced = o.useCoalesced ?? true;
  const usePredicted = o.usePredicted ?? true;
  if (useCoalesced && usePredicted && !o.pen) return rec;
  const events = rec.events.map((e): RecordedEvent => {
    const out: RecordedEvent = { ...e };
    if (!useCoalesced) delete out.coalesced;
    if (!usePredicted) delete out.predicted;
    if (o.pen && out.tool) out.tool = { ...out.tool, pen: { ...out.tool.pen, ...o.pen } };
    return out;
  });
  return { ...rec, events };
}

const DEFAULT_TOOL: ToolState = { kind: "pen", penColor: "#000000", penSize: 3, hlColor: "#fde047", hlSize: 20, eraserSize: 20 };

/** Replays through a real, headless InkController; returns the committed and discarded strokes. */
export function replayStrokes(rec: PencilRecording, o: HarnessOptions = {}): { strokes: ReplayedStroke[]; discarded: StrokeData[] } {
  const prepared = prepare(rec, o);
  const strokes: ReplayedStroke[] = [];
  const discarded: StrokeData[] = [];
  const handles = new Map<string, import("./controller").SectionHandle>();
  for (const e of prepared.events) {
    if (handles.has(e.section)) continue;
    const r = e.rect;
    const el = { getBoundingClientRect: () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }), setPointerCapture() {} } as unknown as HTMLElement;
    handles.set(e.section, { id: e.section, el, strokes: () => [] });
  }
  const recorded = prepared.events.find((e) => e.tool)?.tool;
  const base = o.tool ?? recorded ?? DEFAULT_TOOL;
  const tool = o.pen ? { ...base, pen: { ...base.pen, ...o.pen } } : base;
  let replayer: PencilReplayer | null = null;
  let controller!: InkController;
  const make = () => {
    controller = new InkController(
      "replay",
      tool,
      {
        onSelection() {},
        onDragging() {},
        onTextCreate() {},
        onCommit: (sectionId, data) => strokes.push({ sectionId, data, afterSeq: replayer!.position - 1 }),
        onDiscard: (_sectionId, data) => discarded.push(data),
      },
      { persist: false, now: () => replayer!.clock(), device: "replay" },
    );
    controller.configure(tool, prepared.events[0]?.zoom ?? 1);
  };
  make();
  replayer = new PencilReplayer(prepared, { controller: () => controller, section: (id) => handles.get(id) ?? null, reset: make }, { applyTool: !o.tool });
  replayer.runToEnd();
  // A recording stopped mid-stroke: end it as the editor does when a section unmounts.
  controller.endGesture();
  return { strokes, discarded };
}

/** What identifies the ink: stable across machines and runs, independent of t0 and device. */
function inkKey(s: ReplayedStroke) {
  const d = s.data;
  return JSON.stringify([s.sectionId, d.tool, d.color, d.size, d.input, d.pen ?? {}, d.pts]);
}

/** Replays a recording and measures the result. Deterministic except `performance`. */
export function runReplay(rec: PencilRecording, o: HarnessOptions = {}): ReplayReport {
  const t0 = now();
  const { strokes, discarded } = replayStrokes(rec, o);
  const t1 = now();
  const metrics = strokes.map((s, i) => strokeMetrics(s, i, o.includeSvg));
  const svg = strokes.map((s) => strokeSvgPath(s.data)).join("\n");
  const t2 = now();
  const sum = (f: (m: StrokeMetrics) => number) => r3(metrics.reduce((a, m) => a + f(m), 0));
  return {
    harnessVersion: HARNESS_VERSION,
    recording: recordingStats(rec),
    options: { useCoalesced: o.useCoalesced ?? true, usePredicted: o.usePredicted ?? true, pen: o.pen ?? null, toolOverride: !!o.tool },
    strokes: metrics,
    discarded: { count: discarded.length, points: discarded.map((d) => d.pts.length / STROKE_STRIDE) },
    totals: {
      strokes: metrics.length,
      points: sum((m) => m.points),
      processedPoints: sum((m) => m.processed.points),
      outlinePoints: sum((m) => m.outline.points),
      rawLength: sum((m) => m.rawLength),
      processedLength: sum((m) => m.processed.length),
    },
    fingerprint: fnv1a(strokes.map(inkKey).join("\n")),
    outlineFingerprint: fnv1a(svg),
    // Only meaningful when replaying as recorded: a changed tool or dropped samples differ by design.
    capture: rec.committed && !o.tool && !o.pen && o.useCoalesced !== false ? (() => {
      const differences = diffStrokes(rec.committed, strokes);
      return { matches: differences.length === 0, differences };
    })() : null,
    performance: {
      replayMs: r3(t1 - t0),
      renderMs: r3(t2 - t1),
      eventsPerMs: t1 > t0 ? r3(rec.events.length / (t1 - t0)) : 0,
      note: "CPU time of the headless pipeline in this process; not touch-to-ink latency on the device.",
    },
  };
}

/** The deterministic part of a report, for checked-in baselines: performance and identity left out. */
export function baselineOf(r: ReplayReport) {
  const rest: Partial<ReplayReport> = { ...r, recording: undefined, performance: undefined };
  const rec: Partial<ReplayReport["recording"]> = { ...r.recording, createdAt: undefined, userAgent: undefined };
  // Through JSON, so the left-out fields are gone rather than undefined.
  return JSON.parse(JSON.stringify({ ...rest, recording: rec })) as Omit<ReplayReport, "performance">;
}

/** Field-by-field differences between two baselines, as readable paths: `strokes[2].points: 41 → 39`. */
export function compareBaselines(expected: unknown, actual: unknown, path = "", out: string[] = [], limit = 50): string[] {
  if (out.length >= limit) return out;
  if (typeof expected !== "object" || typeof actual !== "object" || expected === null || actual === null) {
    if (expected !== actual) out.push(`${path || "(root)"}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
    return out;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push(`${path}: shape changed`);
    return out;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length) out.push(`${path}.length: ${expected.length} → ${actual.length}`);
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    const sub = Array.isArray(expected) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    compareBaselines((expected as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], sub, out, limit);
  }
  return out;
}
