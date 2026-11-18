import { describe, expect, it } from "vitest";
import { MAX_EVENTS, PencilRecorder, type PointerLike, type StartOptions, type TransformInput } from "@/ink/recording/recorder";
import {
  RECORDING_VERSION,
  RecordingFormatError,
  SAMPLE_FIELDS,
  TOUCH_FIELDS,
  parseRecording,
  recordingFileName,
  sampleValue,
  serializeRecording,
  touchValue,
} from "@/ink/recording/schema";
import { appendPoint, toLocal } from "@/ink/samples";

// The Pencil recorder keeps what the browser delivered, unfiltered, in a versioned file format.

const transform = (left = 10, zoom = 0.5): TransformInput => ({
  rect: { left, top: 20, width: 688, height: 360 },
  zoom,
  pageWidth: 1376,
  pageHeight: 720,
  devicePixelRatio: 2,
  scroll: { x: 0, y: 0 },
  viewport: { width: 1024, height: 768 },
  visualViewport: null,
  canvas: { cssWidth: 1376, cssHeight: 720, width: 1376, height: 720 },
});

const startOpts = (): StartOptions => ({
  id: "rec123456",
  createdAt: "2026-11-18T09:30:05.123Z",
  timeOrigin: 1_763_000_000_000,
  now: 1000,
  environment: {
    userAgent: "test", platform: "iPad", vendor: "Apple", language: "en", maxTouchPoints: 5, deviceKind: "ipad", deviceId: "dev", standalone: false, secureContext: true,
    screen: { width: 1376, height: 1032, availWidth: 1376, availHeight: 1032, orientation: "landscape-primary", angle: 90 },
    media: { anyPointerFine: true, anyPointerCoarse: true, anyHover: true },
    userAgentData: null,
  },
  apis: { getCoalescedEvents: true, getPredictedEvents: true },
  tool: { tool: "pen", color: "#111827", size: 3.4, pen: {} },
  transform: transform(),
  label: "fox",
  expectedText: "The quick brown fox",
});

/** A pen event as Safari would hand it over: no twist/tangentialPressure keys at all. */
function penEvent(type: string, t: number, x: number, extra: Partial<Record<string, unknown>> = {}, coalesced?: object[], predicted?: object[]): PointerLike {
  const base = { type, timeStamp: t, pointerId: 7, pointerType: "pen", isPrimary: true, isTrusted: true, cancelable: true, clientX: x, clientY: 50, pressure: 0.4 + t / 10_000, tiltX: 12, tiltY: -3, altitudeAngle: 1.1, azimuthAngle: 0.7, width: 1, height: 1, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, ...extra };
  return {
    ...base,
    ...(coalesced ? { getCoalescedEvents: () => coalesced } : {}),
    ...(predicted ? { getPredictedEvents: () => predicted } : {}),
  } as PointerLike;
}

function sampleStroke(r: PencilRecorder) {
  const tr = transform();
  r.pointer(penEvent("pointerdown", 1010, 100, {}, []), "surface", tr, 1011);
  const c1 = [penEvent("pointermove", 1014, 101), penEvent("pointermove", 1018, 102), penEvent("pointermove", 1022, 103)];
  r.pointer(penEvent("pointermove", 1022, 103, {}, c1, [penEvent("pointermove", 1030, 110, { pressure: 0.9 })]), "surface", tr, 1025);
  const c2 = [penEvent("pointermove", 1026, 104), penEvent("pointermove", 1030, 105)];
  r.pointer(penEvent("pointermove", 1030, 105, {}, c2, []), "surface", tr, 1032);
  r.pointer(penEvent("pointerup", 1034, 105, { pressure: 0 }, []), "surface", tr, 1035);
}

describe("PencilRecorder", () => {
  it("records nothing until started, and stops recording on stop", () => {
    const r = new PencilRecorder();
    r.pointer(penEvent("pointerdown", 1, 1), "surface", transform(), 1);
    expect(r.state).toBe("idle");
    expect(() => r.toRecording()).toThrow();
    r.start(startOpts());
    sampleStroke(r);
    r.stop(1100);
    r.pointer(penEvent("pointerdown", 1200, 1), "surface", transform(), 1200);
    const rec = r.toRecording();
    expect(rec.events.map((e) => e.type)).toEqual(["record-start", "pointerdown", "pointermove", "pointermove", "pointerup", "record-stop"]);
    expect(rec.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rec.stats.durationMs).toBe(100);
  });

  it("keeps coalesced samples as observed input and predictions apart, unrounded", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    sampleStroke(r);
    const moves = r.toRecording().events.filter((e) => e.kind === "pointer" && e.type === "pointermove");
    const first = moves[0];
    if (first.kind !== "pointer") throw new Error("pointer");
    expect(first.coalesced?.map((s) => sampleValue(s, "clientX"))).toEqual([101, 102, 103]);
    expect(first.predicted?.map((s) => sampleValue(s, "clientX"))).toEqual([110]);
    expect(sampleValue(first.coalesced![1], "pressure")).toBe(0.4 + 1018 / 10_000);
    const stats = r.stats();
    expect(stats.coalescedSamples).toBe(5);
    expect(stats.predictedSamples).toBe(1);
    expect(stats.strokes).toBe(1);
    // Predictions never count towards field statistics: pressure 0.9 was only predicted.
    const pressure = r.capabilities().pointerTypes.pen.fields.pressure;
    expect(pressure.status === "varies" && pressure.max).toBeLessThan(0.9);
  });

  it("records missing fields as null and reports them unavailable, constant fields as constant", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    sampleStroke(r);
    const rec = r.toRecording();
    const down = rec.events.find((e) => e.type === "pointerdown");
    if (down?.kind !== "pointer") throw new Error("pointer");
    expect(sampleValue(down.sample, "twist")).toBeNull();
    expect(down.persistentDeviceId).toBeNull();
    const fields = rec.capabilities.pointerTypes.pen.fields;
    expect(fields.twist).toEqual({ status: "unavailable" });
    expect(fields.tiltX).toEqual({ status: "constant", value: 12 });
    expect(fields.clientX.status).toBe("varies");
    expect(rec.capabilities.penUnavailable).toEqual(expect.arrayContaining(["twist", "tangentialPressure", "pageX", "offsetX"]));
    expect(rec.capabilities.notExposed.length).toBeGreaterThan(0);
  });

  it("returns null lists when the coalesced/predicted APIs are missing or throw", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    const throwing = { ...penEvent("pointermove", 1010, 5), getCoalescedEvents: () => { throw new Error("outside dispatch"); } } as PointerLike;
    r.pointer(throwing, "surface", transform(), 1011);
    const e = r.toRecording().events[1];
    if (e.kind !== "pointer") throw new Error("pointer");
    expect(e.coalesced).toBeNull();
    expect(e.predicted).toBeNull();
  });

  it("stores a transform only when it changes and references it from each event", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    r.pointer(penEvent("pointerdown", 1010, 1), "surface", transform(), 1010);
    r.pointer(penEvent("pointermove", 1014, 2), "surface", transform(), 1014);
    r.pointer(penEvent("pointermove", 1018, 3), "surface", transform(40, 0.75), 1018);
    const rec = r.toRecording();
    expect(rec.transforms.map((t) => t.id)).toEqual([0, 1]);
    expect(rec.events.map((e) => ("transform" in e ? e.transform : null))).toEqual([0, 0, 0, 1]);
  });

  it("records touches with touchType, force and contact geometry", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    const touch = { identifier: 3, touchType: "stylus", clientX: 5, clientY: 6, pageX: 5, pageY: 6, screenX: 5, screenY: 6, radiusX: 0.5, radiusY: 0.5, rotationAngle: 0, force: 0.3, altitudeAngle: 1.2, azimuthAngle: 2 };
    const palm = { identifier: 4, clientX: 50, clientY: 60, radiusX: 30, radiusY: 22, rotationAngle: 0, force: 0 };
    r.touch({ type: "touchstart", timeStamp: 1010, cancelable: true, changedTouches: [touch, palm], touches: [touch, palm] }, "surface", transform(), 1011);
    const e = r.toRecording().events[1];
    if (e.kind !== "touch") throw new Error("touch");
    expect(e.changed).toHaveLength(2);
    expect(touchValue(e.changed[0], "touchType")).toBe(1);
    expect(touchValue(e.changed[1], "touchType")).toBeNull();
    expect(touchValue(e.changed[1], "radiusX")).toBe(30);
    expect(touchValue(e.changed[1], "altitudeAngle")).toBeNull();
    expect(e.active).toEqual([3, 4]);
    expect(r.capabilities().stylusTouchSeen).toBe(true);
  });

  it("measures the pen sample interval from observed samples while pressed", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    const tr = transform();
    r.pointer(penEvent("pointerdown", 1000, 0, {}, []), "surface", tr, 1000);
    for (let i = 1; i <= 20; i++) {
      const t = 1000 + i * 16;
      const c = [0, 1, 2, 3].map((k) => penEvent("pointermove", t - 12 + k * 4, i * 4 + k));
      r.pointer(penEvent("pointermove", t, i * 4 + 3, {}, c), "surface", tr, t);
    }
    expect(r.stats().penIntervalMs).toBe(4);
  });

  it("stops keeping events at the limit and marks the recording truncated", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    for (let i = 0; i < MAX_EVENTS + 5; i++) r.marker("scroll", i, i);
    expect(r.isTruncated()).toBe(true);
    const rec = r.toRecording();
    expect(rec.events).toHaveLength(MAX_EVENTS);
    expect(rec.truncated).toBe(true);
  });

  it("reset clears everything", () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    sampleStroke(r);
    r.reset();
    expect(r.state).toBe("idle");
    expect(r.stats().events).toBe(0);
    expect(r.last).toBeNull();
  });
});

describe("recording files", () => {
  const recorded = () => {
    const r = new PencilRecorder();
    r.start(startOpts());
    sampleStroke(r);
    r.touch({ type: "touchend", timeStamp: 1040, changedTouches: [{ identifier: 1 }], touches: [] }, "other", transform(), 1040);
    r.stop(1100);
    return r.toRecording();
  };

  it("round-trips through JSON with column headers and limitations", () => {
    const rec = recorded();
    const back = parseRecording(serializeRecording(rec));
    expect(back).toEqual(rec);
    expect(back.version).toBe(RECORDING_VERSION);
    expect(back.sampleFields).toEqual([...SAMPLE_FIELDS]);
    expect(back.touchFields).toEqual([...TOUCH_FIELDS]);
    expect(back.limitations.join(" ")).toMatch(/not sensor-level/);
    expect(back.expectedText).toBe("The quick brown fox");
  });

  it("rejects other files, other versions and malformed recordings with a reason", () => {
    expect(() => parseRecording("nope")).toThrow(RecordingFormatError);
    expect(() => parseRecording({ format: "other" })).toThrow(/Not a padSync Pencil recording/);
    expect(() => parseRecording({ ...recorded(), version: 2 })).toThrow(/Unsupported recording version 2/);
    const bad = recorded();
    const ev = bad.events[1];
    if (ev.kind === "pointer") ev.sample = ev.sample.slice(1);
    expect(() => parseRecording(JSON.stringify(bad))).toThrow(/columns/);
    const orphan = recorded();
    if (orphan.events[1].kind === "pointer") orphan.events[1].transform = 99;
    expect(() => parseRecording(orphan)).toThrow(/missing transform/);
    const missing = { ...recorded() } as Record<string, unknown>;
    delete missing.environment;
    expect(() => parseRecording(missing)).toThrow(/environment/);
  });

  it("names files by time, label and id", () => {
    expect(recordingFileName({ createdAt: "2026-11-18T09:30:05.123Z", label: "Cursive: The Fox!", id: "abcdefgh" })).toBe("pencil-20261118-093005-cursive-the-fox-abcdef.json");
    expect(recordingFileName({ createdAt: "2026-11-18T09:30:05.123Z", label: "", id: "abcdefgh" })).toBe("pencil-20261118-093005-abcdef.json");
  });
});

describe("shared stroke point path", () => {
  it("maps client points through the recorded transform and stores them as the controller does", () => {
    const tr = transform();
    const [x, y] = toLocal(110, 70, tr.rect, tr.zoom);
    expect([x, y]).toEqual([200, 100]);
    const pts: number[] = [];
    expect(appendPoint(pts, x, y, { pointerType: "pen", pressure: 0.41234, altitudeAngle: 1.0001, azimuthAngle: null, timeStamp: 1012.6 }, 1000, true)).toBe(true);
    expect(pts).toEqual([200, 100, 0.412, 1, 0, 13]);
    // Exact repeats and samples older than the last are dropped.
    expect(appendPoint(pts, x, y, { pointerType: "pen", pressure: 0.5, timeStamp: 1020 }, 1000, true)).toBe(false);
    expect(appendPoint(pts, 201, 100, { pointerType: "pen", pressure: 0.5, timeStamp: 1005 }, 1000, true)).toBe(false);
    expect(appendPoint(pts, 201, 100, { pointerType: "pen", pressure: 0.5, timeStamp: 1005 }, 1000, false)).toBe(true);
    // Mouse pressure is fixed at 0.5, missing angles default to upright.
    expect(appendPoint(pts, 300, 100, { pointerType: "mouse", pressure: 0, timeStamp: 1030 }, 1000, true)).toBe(true);
    expect(pts.slice(-6)).toEqual([300, 100, 0.5, Math.round((Math.PI / 2) * 1000) / 1000, 0, 30]);
  });
});
