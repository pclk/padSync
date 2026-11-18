import { z } from "zod";
import type { StrokeData } from "@/lib/types";
import type { InputKind, ToolState } from "./controller";

// Pencil recordings: the raw input the ink controller received, saved to a file so it can be
// replayed through the same controller later (replay.ts) by tests or the Pencil lab. Samples are
// kept exactly as the browser reported them (client coordinates and event timeStamps, unrounded);
// each event also carries the section rect and zoom the controller used, so replay can map the
// writing onto a section placed elsewhere. See docs/pencil-test-handoff.md.

export const RECORDING_FORMAT = "padsync.pencil-recording";
export const RECORDING_VERSION = 1;

/** Limits on an imported file: a few minutes of 240 Hz Pencil writing fits well inside them. */
export const MAX_RECORDING_BYTES = 25_000_000;
export const MAX_EVENTS = 200_000;
export const MAX_SAMPLES_PER_EVENT = 256;
export const MAX_TOTAL_SAMPLES = 1_000_000;
export const MAX_SECTIONS = 200;
export const MAX_COMMITTED = 20_000;

export interface RecordedSample {
  /** The event's timeStamp (ms, the page's performance clock), unchanged. */
  timeStamp: number;
  clientX: number;
  clientY: number;
  pressure: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  width?: number;
  height?: number;
  tangentialPressure?: number;
}

export interface RecordedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RecordedEvent {
  /** 0, 1, 2…: the order the controller received the events in. Replay follows it. */
  seq: number;
  /** The controller entry point (down, move, up, lost, grab). */
  kind: InputKind;
  /** The DOM event type: pointerdown, pointermove, pointerup, pointercancel, lostpointercapture. */
  type: string;
  section: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  /** The section's client rect and the zoom when the event arrived: section x = (clientX - left) / zoom. */
  rect: RecordedRect;
  zoom: number;
  sample: RecordedSample;
  /** getCoalescedEvents() of a move, when it returned any. */
  coalesced?: RecordedSample[];
  /** getPredictedEvents() of a move, when it returned any. */
  predicted?: RecordedSample[];
  /** The tool in force, on the first event and whenever it changed since the previous one. */
  tool?: ToolState;
}

export interface CommittedStroke {
  /** seq of the event that ended the stroke. */
  afterSeq: number;
  sectionId: string;
  data: StrokeData;
}

export interface PencilRecording {
  format: typeof RECORDING_FORMAT;
  version: typeof RECORDING_VERSION;
  id: string;
  label: string;
  notes?: string;
  /** ISO time the recording started. */
  createdAt: string;
  /** "device" for real input; "synthetic" for generated fixtures (never claim hardware for these). */
  source: "device" | "synthetic";
  environment: {
    userAgent: string;
    platform?: string;
    maxTouchPoints?: number;
    devicePixelRatio: number;
    viewport: { width: number; height: number };
  };
  /** Page coordinate width the sections were laid out for (PAGE_WIDTH). */
  pageWidth: number;
  /** timeStamp of the first event; playback times are measured from it. */
  timeOrigin: number;
  sections: { id: string; width: number; height: number }[];
  events: RecordedEvent[];
  /** What the controller committed while recording, to compare replays against. */
  committed?: CommittedStroke[];
}

const finite = z.number().refine(Number.isFinite, "must be a finite number");
const short = z.string().max(200);
const sample = z.object({
  timeStamp: finite,
  clientX: finite,
  clientY: finite,
  pressure: z.number().min(0).max(1),
  altitudeAngle: finite.optional(),
  azimuthAngle: finite.optional(),
  tiltX: finite.optional(),
  tiltY: finite.optional(),
  twist: finite.optional(),
  width: finite.optional(),
  height: finite.optional(),
  tangentialPressure: finite.optional(),
});
const samples = z.array(sample).max(MAX_SAMPLES_PER_EVENT);
const tool = z.object({
  kind: z.enum(["pen", "highlighter", "eraser", "lasso", "text"]),
  penColor: short,
  penSize: z.number().positive().max(200),
  hlColor: short,
  hlSize: z.number().positive().max(400),
  eraserSize: z.number().positive().max(400),
  pen: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
  penSmoothing: z.number().optional(),
  penSensitivity: z.number().optional(),
});
const event = z.object({
  seq: z.number().int().min(0),
  kind: z.enum(["down", "move", "up", "lost", "grab"]),
  type: z.enum(["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]),
  section: short,
  pointerId: z.number().int(),
  pointerType: z.enum(["pen", "mouse", "touch"]),
  button: z.number().int(),
  buttons: z.number().int().min(0),
  rect: z.object({ left: finite, top: finite, width: finite, height: finite }),
  zoom: z.number().positive().max(20),
  sample,
  coalesced: samples.optional(),
  predicted: samples.optional(),
  tool: tool.optional(),
});
const strokeData = z.object({
  tool: z.enum(["pen", "highlighter"]),
  color: short,
  size: z.number(),
  pts: z.array(finite).refine((p) => p.length % 6 === 0, "must hold 6 numbers per point"),
  t0: finite,
  input: short,
  device: short,
  smoothing: z.number().optional(),
  sensitivity: z.number().optional(),
  pen: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
});
const recording = z.object({
  format: z.literal(RECORDING_FORMAT),
  version: z.literal(RECORDING_VERSION),
  id: short.min(1),
  label: short,
  notes: z.string().max(10_000).optional(),
  createdAt: short,
  source: z.enum(["device", "synthetic"]),
  environment: z.object({
    userAgent: z.string().max(1000),
    platform: short.optional(),
    maxTouchPoints: z.number().optional(),
    devicePixelRatio: z.number().positive(),
    viewport: z.object({ width: finite, height: finite }),
  }),
  pageWidth: z.number().positive(),
  timeOrigin: finite,
  sections: z.array(z.object({ id: short.min(1), width: finite, height: finite })).max(MAX_SECTIONS),
  events: z.array(event).max(MAX_EVENTS),
  committed: z.array(z.object({ afterSeq: z.number().int().min(0), sectionId: short, data: strokeData })).max(MAX_COMMITTED).optional(),
});

export type ParseRecordingResult = { ok: true; recording: PencilRecording } | { ok: false; errors: string[] };

const pathText = (path: PropertyKey[]) =>
  path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i ? "." : ""}${String(p)}`)).join("") || "(root)";

/** Checks what the schema alone can't: order, references and the total size. */
function crossCheck(r: PencilRecording): string[] {
  const errors: string[] = [];
  const sections = new Set(r.sections.map((s) => s.id));
  let total = 0;
  r.events.forEach((e, i) => {
    if (e.seq !== i) errors.push(`events[${i}].seq: expected ${i}, found ${e.seq} (events must be in order with no gaps)`);
    if (!sections.has(e.section)) errors.push(`events[${i}].section: "${e.section}" is not listed in sections`);
    const isUp = e.type === "pointerup" || e.type === "pointercancel";
    if ((e.kind === "down" || e.kind === "grab") !== (e.type === "pointerdown")) errors.push(`events[${i}]: kind "${e.kind}" doesn't match type "${e.type}"`);
    if (e.kind === "up" && !isUp) errors.push(`events[${i}]: kind "up" needs type pointerup or pointercancel`);
    if (e.kind === "move" && e.type !== "pointermove") errors.push(`events[${i}]: kind "move" needs type pointermove`);
    if (e.kind === "lost" && e.type !== "lostpointercapture") errors.push(`events[${i}]: kind "lost" needs type lostpointercapture`);
    total += 1 + (e.coalesced?.length ?? 0) + (e.predicted?.length ?? 0);
  });
  if (total > MAX_TOTAL_SAMPLES) errors.push(`events: ${total} samples in all, more than the limit of ${MAX_TOTAL_SAMPLES}`);
  r.committed?.forEach((c, i) => {
    if (c.afterSeq >= r.events.length) errors.push(`committed[${i}].afterSeq: ${c.afterSeq} is past the last event`);
  });
  return errors.slice(0, 20);
}

/** Validates parsed JSON as a recording. Errors name the field, e.g. `events[12].sample.pressure: …`. */
export function validateRecording(json: unknown): ParseRecordingResult {
  if (!json || typeof json !== "object") return { ok: false, errors: ["(root): not a JSON object"] };
  const head = json as { format?: unknown; version?: unknown };
  if (head.format !== RECORDING_FORMAT) return { ok: false, errors: [`format: expected "${RECORDING_FORMAT}", found ${JSON.stringify(head.format) ?? "nothing"} (not a padSync Pencil recording)`] };
  if (head.version !== RECORDING_VERSION) return { ok: false, errors: [`version: this build reads version ${RECORDING_VERSION}, the file is version ${JSON.stringify(head.version)}`] };
  const r = recording.safeParse(json);
  if (!r.success) return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${pathText(i.path)}: ${i.message}`) };
  const rec = r.data as PencilRecording;
  const errors = crossCheck(rec);
  return errors.length ? { ok: false, errors } : { ok: true, recording: deepFreeze(rec) };
}

/** Parses a recording file's text: size limit, JSON, then validateRecording. */
export function parseRecording(text: string): ParseRecordingResult {
  // UTF-16 length is at most the UTF-8 byte count for this content, a cheap first bound.
  if (text.length > MAX_RECORDING_BYTES) return { ok: false, errors: [`file: ${(text.length / 1e6).toFixed(1)} MB, more than the ${MAX_RECORDING_BYTES / 1e6} MB limit`] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`file: not valid JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  return validateRecording(json);
}

/** The file text for a recording. Numbers are written as is, so parse(serialize(r)) equals r. */
export function serializeRecording(r: PencilRecording): string {
  return JSON.stringify(r);
}

export function recordingFileName(r: Pick<PencilRecording, "label" | "createdAt">): string {
  const slug = r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recording";
  return `pencil-${slug}-${r.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
}

/** Imported recordings are frozen: replay reads them, nothing may change the raw samples. */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Playback length in ms (first to last event). */
export function recordingDuration(r: Pick<PencilRecording, "events" | "timeOrigin">): number {
  let end = 0;
  for (const e of r.events) end = Math.max(end, e.sample.timeStamp - r.timeOrigin);
  return end;
}
