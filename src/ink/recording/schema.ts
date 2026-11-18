import { z } from "zod";

// Pencil input recordings: what the browser delivered to the page, in dispatch order, before any
// app filtering, smoothing or palm rejection, plus what is needed to replay it (coordinate
// transforms, surface size, pen settings, device). Saved as JSON; parsed back with
// parseRecording, which checks the format and version.
//
// This is browser input, not sensor data. Pointer and touch events are what WebKit/Blink chose to
// expose after their own processing: positions are CSS px, timestamps are the browser's, and
// which fields carry real values depends on the browser, OS and stylus. Fields a browser does not
// expose are recorded as null, never guessed.

export const RECORDING_FORMAT = "padsync.pencil-recording";
export const RECORDING_VERSION = 1;

/**
 * Columns of every recorded pointer sample tuple (dispatched, coalesced and predicted), in order.
 * null: the event had no such property (or a non-finite value) in this browser.
 */
export const SAMPLE_FIELDS = [
  "timeStamp",
  "clientX",
  "clientY",
  "pageX",
  "pageY",
  "screenX",
  "screenY",
  "offsetX",
  "offsetY",
  "movementX",
  "movementY",
  "pressure",
  "tangentialPressure",
  "tiltX",
  "tiltY",
  "twist",
  "altitudeAngle",
  "azimuthAngle",
  "width",
  "height",
  "button",
  "buttons",
] as const;
export type SampleField = (typeof SAMPLE_FIELDS)[number];
/** One pointer sample: a value (or null) per SAMPLE_FIELDS column. */
export type SampleTuple = (number | null)[];

/** Columns of every recorded Touch tuple. touchType: 1 stylus, 0 direct, null not exposed. */
export const TOUCH_FIELDS = [
  "identifier",
  "touchType",
  "clientX",
  "clientY",
  "pageX",
  "pageY",
  "screenX",
  "screenY",
  "radiusX",
  "radiusY",
  "rotationAngle",
  "force",
  "altitudeAngle",
  "azimuthAngle",
] as const;
export type TouchField = (typeof TOUCH_FIELDS)[number];
export type TouchTuple = (number | null)[];

/** Modifier bitmask on pointer and touch events. */
export const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** Where the event's target was: the writing surface, the test page's own controls, or elsewhere. */
export type TargetKind = "surface" | "ui" | "other";

/**
 * The mapping from client coordinates to surface coordinates at a moment in the recording.
 * Surface-local = ((clientX - rect.left) / zoom, (clientY - rect.top) / zoom); the surface is
 * pageWidth × pageHeight units (1 unit = 1 CSS px at zoom 1), as a notebook section.
 */
export interface TransformSnapshot {
  id: number;
  /** The surface element's client rect (getBoundingClientRect), CSS px. */
  rect: { left: number; top: number; width: number; height: number };
  zoom: number;
  pageWidth: number;
  pageHeight: number;
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  visualViewport: { offsetLeft: number; offsetTop: number; pageLeft: number; pageTop: number; width: number; height: number; scale: number } | null;
  /** The preview ink canvas: CSS size and backing store size. */
  canvas: { cssWidth: number; cssHeight: number; width: number; height: number } | null;
}

interface EventBase {
  /** Dispatch order across every recorded event. */
  seq: number;
  /** event.timeStamp (ms on the performance timeline, see header.timeOrigin), or performance.now() for app markers. */
  t: number;
  /** performance.now() when the recorder's listener ran; recv - t is the delivery delay. */
  recv: number;
}

export interface PointerRecord extends EventBase {
  kind: "pointer";
  /** DOM event type: pointerdown, pointermove, pointerrawupdate, pointerup, pointercancel, pointerover, … */
  type: string;
  target: TargetKind;
  transform: number;
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  /** PointerEvent.persistentDeviceId where exposed (Chromium); null otherwise. */
  persistentDeviceId: number | null;
  modifiers: number;
  isTrusted: boolean;
  cancelable: boolean;
  /** The dispatched event's own values. */
  sample: SampleTuple;
  /** getCoalescedEvents(), as returned (observed input); null where the API is missing. */
  coalesced: SampleTuple[] | null;
  /** getPredictedEvents(): the browser's guesses ahead of the pen, NOT observed input. null where missing. */
  predicted: SampleTuple[] | null;
}

export interface TouchRecord extends EventBase {
  kind: "touch";
  /** touchstart, touchmove, touchend, touchcancel. */
  type: string;
  target: TargetKind;
  transform: number;
  modifiers: number;
  isTrusted: boolean;
  cancelable: boolean;
  /** changedTouches. */
  changed: TouchTuple[];
  /** Identifiers in event.touches (all contacts still on the screen). */
  active: number[];
}

export interface MarkerRecord extends EventBase {
  kind: "marker";
  /** record-start, record-stop, visibilitychange, pagehide, pageshow, blur, focus, resize, orientationchange, scroll, surface-reset. */
  type: string;
  transform: number | null;
  detail: Record<string, string | number | boolean | null>;
}

export type RecordedEvent = PointerRecord | TouchRecord | MarkerRecord;

export type FieldStatus =
  /** Never present on any event of this pointer type. */
  | { status: "unavailable" }
  /** Present but always one value (e.g. tiltX 0 for a mouse): exposed, but carries nothing. */
  | { status: "constant"; value: number }
  | { status: "varies"; min: number; max: number };

export interface PointerTypeCapabilities {
  events: number;
  /** Observed samples (dispatched + coalesced) the field statistics are over. */
  samples: number;
  fields: Record<SampleField, FieldStatus>;
}

export interface Capabilities {
  /** APIs this browser exposes (feature detection, not use). */
  apis: Record<string, boolean>;
  /** Field statistics per pointerType seen ("pen", "mouse", "touch"). */
  pointerTypes: Record<string, PointerTypeCapabilities>;
  /** Touch.touchType seen as stylus at least once. */
  stylusTouchSeen: boolean;
  /** Fields never available on any observed pen sample (empty when no pen was seen). */
  penUnavailable: SampleField[];
  /** What a web page cannot get at all, whatever the browser. */
  notExposed: string[];
}

export interface RecordingEnvironment {
  userAgent: string;
  platform: string;
  vendor: string;
  language: string;
  maxTouchPoints: number;
  deviceKind: string;
  deviceId: string;
  standalone: boolean;
  secureContext: boolean;
  screen: { width: number; height: number; availWidth: number; availHeight: number; orientation: string | null; angle: number | null };
  media: { anyPointerFine: boolean; anyPointerCoarse: boolean; anyHover: boolean };
  userAgentData: { platform: string; mobile: boolean; brands: string[] } | null;
}

export interface RecordingTool {
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  /** Pen parameters differing from the defaults (pen-feel.ts), as a stroke stores them. */
  pen: Record<string, number | boolean | string>;
}

export interface RecordingStats {
  events: number;
  pointerEvents: number;
  touchEvents: number;
  markers: number;
  coalescedSamples: number;
  predictedSamples: number;
  /** pointerdown on the surface by a pen or mouse: a stroke started. */
  strokes: number;
  cancels: number;
  byType: Record<string, number>;
  byPointerType: Record<string, number>;
  /** Median interval between consecutive observed pen samples while pressed, ms (null: too few). */
  penIntervalMs: number | null;
  durationMs: number;
}

export interface PencilRecording {
  format: typeof RECORDING_FORMAT;
  version: typeof RECORDING_VERSION;
  id: string;
  createdAt: string;
  /** performance.timeOrigin: event times + timeOrigin = Unix ms. */
  timeOrigin: number;
  startT: number;
  stopT: number | null;
  /** What the writer meant to write, for tests that check the result. */
  label: string;
  expectedText: string;
  app: { name: "padsync"; surface: "pencil-test" };
  environment: RecordingEnvironment;
  tool: RecordingTool;
  sampleFields: SampleField[];
  touchFields: TouchField[];
  transforms: TransformSnapshot[];
  events: RecordedEvent[];
  capabilities: Capabilities;
  stats: RecordingStats;
  /** Set when the recorder hit its event limit and stopped keeping events. */
  truncated: boolean;
  limitations: string[];
}

export const LIMITATIONS = [
  "Browser input events, not sensor-level data: positions, pressure and angles are what the browser exposes after its own processing, in CSS px and the browser's units.",
  "Timestamps are event.timeStamp (browser time on the performance timeline), not digitizer hardware times.",
  "Which fields carry values depends on browser, OS and stylus; see capabilities. Unavailable fields are null.",
  "Predicted samples are the browser's extrapolation and are stored separately from observed input.",
  "Coalesced samples are stored as the browser returned them; their number and spacing depend on the browser and frame timing.",
] as const;

// Validation. Structure is checked strictly enough that a test can trust the shape; numbers are
// allowed to be any finite value or null, as browsers report them.

const num = z.number();
const tuple = z.array(num.nullable());
const rect = z.object({ left: num, top: num, width: num, height: num });

const transformSchema = z.object({
  id: z.number().int(),
  rect,
  zoom: num.positive(),
  pageWidth: num.positive(),
  pageHeight: num.positive(),
  devicePixelRatio: num.positive(),
  scroll: z.object({ x: num, y: num }),
  viewport: z.object({ width: num, height: num }),
  visualViewport: z.object({ offsetLeft: num, offsetTop: num, pageLeft: num, pageTop: num, width: num, height: num, scale: num }).nullable(),
  canvas: z.object({ cssWidth: num, cssHeight: num, width: num, height: num }).nullable(),
});

const base = { seq: z.number().int().nonnegative(), t: num, recv: num };
const target = z.enum(["surface", "ui", "other"]);

const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("pointer"),
    type: z.string(),
    target,
    transform: z.number().int(),
    pointerId: num,
    pointerType: z.string(),
    isPrimary: z.boolean(),
    persistentDeviceId: num.nullable(),
    modifiers: z.number().int(),
    isTrusted: z.boolean(),
    cancelable: z.boolean(),
    sample: tuple,
    coalesced: z.array(tuple).nullable(),
    predicted: z.array(tuple).nullable(),
  }),
  z.object({
    ...base,
    kind: z.literal("touch"),
    type: z.string(),
    target,
    transform: z.number().int(),
    modifiers: z.number().int(),
    isTrusted: z.boolean(),
    cancelable: z.boolean(),
    changed: z.array(tuple),
    active: z.array(num),
  }),
  z.object({
    ...base,
    kind: z.literal("marker"),
    type: z.string(),
    transform: z.number().int().nullable(),
    detail: z.record(z.string(), z.union([z.string(), num, z.boolean(), z.null()])),
  }),
]);

const fieldStatus = z.union([
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("constant"), value: num }),
  z.object({ status: z.literal("varies"), min: num, max: num }),
]);

const recordingSchema = z.object({
  format: z.literal(RECORDING_FORMAT),
  version: z.literal(RECORDING_VERSION),
  id: z.string(),
  createdAt: z.string(),
  timeOrigin: num,
  startT: num,
  stopT: num.nullable(),
  label: z.string(),
  expectedText: z.string(),
  app: z.object({ name: z.literal("padsync"), surface: z.literal("pencil-test") }),
  environment: z.object({
    userAgent: z.string(),
    platform: z.string(),
    vendor: z.string(),
    language: z.string(),
    maxTouchPoints: num,
    deviceKind: z.string(),
    deviceId: z.string(),
    standalone: z.boolean(),
    secureContext: z.boolean(),
    screen: z.object({ width: num, height: num, availWidth: num, availHeight: num, orientation: z.string().nullable(), angle: num.nullable() }),
    media: z.object({ anyPointerFine: z.boolean(), anyPointerCoarse: z.boolean(), anyHover: z.boolean() }),
    userAgentData: z.object({ platform: z.string(), mobile: z.boolean(), brands: z.array(z.string()) }).nullable(),
  }),
  tool: z.object({ tool: z.enum(["pen", "highlighter"]), color: z.string(), size: num.positive(), pen: z.record(z.string(), z.union([num, z.boolean(), z.string()])) }),
  sampleFields: z.array(z.string()),
  touchFields: z.array(z.string()),
  transforms: z.array(transformSchema),
  events: z.array(eventSchema),
  capabilities: z.object({
    apis: z.record(z.string(), z.boolean()),
    pointerTypes: z.record(z.string(), z.object({ events: num, samples: num, fields: z.record(z.string(), fieldStatus) })),
    stylusTouchSeen: z.boolean(),
    penUnavailable: z.array(z.string()),
    notExposed: z.array(z.string()),
  }),
  stats: z.object({
    events: num,
    pointerEvents: num,
    touchEvents: num,
    markers: num,
    coalescedSamples: num,
    predictedSamples: num,
    strokes: num,
    cancels: num,
    byType: z.record(z.string(), num),
    byPointerType: z.record(z.string(), num),
    penIntervalMs: num.nullable(),
    durationMs: num,
  }),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

export class RecordingFormatError extends Error {}

export function serializeRecording(r: PencilRecording): string {
  return JSON.stringify(r);
}

/** Parses and validates a saved recording; throws RecordingFormatError with the reason. */
export function parseRecording(json: string | unknown): PencilRecording {
  let raw: unknown = json;
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json);
    } catch {
      throw new RecordingFormatError("Not JSON");
    }
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (!head || typeof head !== "object" || head.format !== RECORDING_FORMAT) throw new RecordingFormatError("Not a padSync Pencil recording");
  if (head.version !== RECORDING_VERSION) throw new RecordingFormatError(`Unsupported recording version ${String(head.version)} (this build reads ${RECORDING_VERSION})`);
  const parsed = recordingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecordingFormatError(`Invalid recording at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const r = parsed.data as PencilRecording;
  const width = (cols: readonly string[], rows: (number | null)[][], what: string) => {
    for (const row of rows) if (row.length !== cols.length) throw new RecordingFormatError(`A ${what} tuple has ${row.length} values for ${cols.length} columns`);
  };
  if (r.sampleFields.join() !== SAMPLE_FIELDS.join()) throw new RecordingFormatError("sampleFields differ from this version's columns");
  if (r.touchFields.join() !== TOUCH_FIELDS.join()) throw new RecordingFormatError("touchFields differ from this version's columns");
  const ids = new Set(r.transforms.map((t) => t.id));
  for (const e of r.events) {
    if (e.kind === "pointer") {
      width(SAMPLE_FIELDS, [e.sample, ...(e.coalesced ?? []), ...(e.predicted ?? [])], "pointer sample");
      if (!ids.has(e.transform)) throw new RecordingFormatError(`Event ${e.seq} refers to missing transform ${e.transform}`);
    } else if (e.kind === "touch") {
      width(TOUCH_FIELDS, e.changed, "touch");
      if (!ids.has(e.transform)) throw new RecordingFormatError(`Event ${e.seq} refers to missing transform ${e.transform}`);
    }
  }
  return r;
}

/** Reads one column of a sample tuple by name. */
export function sampleValue(s: SampleTuple, field: SampleField): number | null {
  return s[SAMPLE_FIELDS.indexOf(field)] ?? null;
}

export function touchValue(s: TouchTuple, field: TouchField): number | null {
  return s[TOUCH_FIELDS.indexOf(field)] ?? null;
}

/** A file name that sorts by time: pencil-20261118-143005-<label>-<id>.json. */
export function recordingFileName(rec: Pick<PencilRecording, "createdAt" | "label" | "id">): string {
  const stamp = rec.createdAt.replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  const slug = rec.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `pencil-${stamp}${slug ? `-${slug}` : ""}-${rec.id.slice(0, 6)}.json`;
}
