import { describe, expect, it } from "vitest";
import { InkController, type SectionHandle } from "@/ink/controller";
import { MAX_RECORDING_BYTES, parseRecording, recordingFileName, serializeRecording, validateRecording, type PencilRecording, type RecordedSample } from "@/ink/recording";
import { PencilReplayer, type Scheduler } from "@/ink/replay";
import { baselineOf, compareBaselines, recordingStats, replayStrokes, runReplay } from "@/ink/replay-harness";
import { STROKE_STRIDE, type StrokeData } from "@/lib/types";
import { FIXTURES } from "./helpers/pencil-fixtures";
import { letterPaths, synthesize } from "./helpers/synthetic-pencil";

// The record → file → replay workflow, end to end through the real InkController and render
// pipeline, on SYNTHETIC input (tests/helpers/synthetic-pencil.ts). See docs/pencil-test-handoff.md.

const round = (v: number, f: number) => Math.round(v * f) / f;
const points = (d: StrokeData) => Array.from({ length: d.pts.length / STROKE_STRIDE }, (_, i) => d.pts.slice(i * STROKE_STRIDE, (i + 1) * STROKE_STRIDE));

const simple = (o: Partial<Parameters<typeof synthesize>[0]> = {}) =>
  synthesize({ label: "test", strokes: [{ path: [[100, 100], [160, 130], [220, 100]], durationMs: 200 }], ...o });

/** The points the controller should store for one gesture, worked out from the raw recording alone. */
function expectedPoints(rec: PencilRecording, from: number): number[][] {
  const down = rec.events[from];
  const out: number[][] = [];
  const push = (s: RecordedSample) => {
    const x = round((s.clientX - down.rect.left) / down.zoom, 100);
    const y = round((s.clientY - down.rect.top) / down.zoom, 100);
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) return;
    const t = Math.max(0, Math.round(s.timeStamp - down.sample.timeStamp));
    if (last && t < last[5]) return;
    out.push([x, y, round(s.pressure, 1000), round(s.altitudeAngle ?? Math.PI / 2, 1000), round(s.azimuthAngle ?? 0, 1000), t]);
  };
  push(down.sample);
  for (const e of rec.events.slice(from + 1)) {
    if (e.pointerId !== down.pointerId) continue;
    if (e.type === "pointermove") (e.coalesced?.length ? e.coalesced : [e.sample]).forEach(push);
    else {
      if (e.type === "pointerup") push(e.sample);
      break;
    }
  }
  return out;
}

describe("sample fidelity and order", () => {
  const rec = FIXTURES["synthetic-words"]();

  it("records every controller input in order, with raw (unrounded) client samples", () => {
    expect(rec.events.map((e) => e.seq)).toEqual(rec.events.map((_, i) => i));
    const ts = rec.events.map((e) => e.sample.timeStamp);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // Raw values are kept as delivered: client coordinates aren't rounded to the stored 0.01.
    expect(rec.events.some((e) => e.sample.clientX !== round(e.sample.clientX, 100))).toBe(true);
  });

  it("stores exactly the samples the recording holds, in order, as section-local points", () => {
    const { strokes } = replayStrokes(rec);
    const downs = rec.events.flatMap((e, i) => (e.type === "pointerdown" ? [i] : []));
    expect(strokes).toHaveLength(downs.length);
    strokes.forEach((s, k) => expect(points(s.data)).toEqual(expectedPoints(rec, downs[k])));
  });
});

describe("timing", () => {
  const rec = simple();

  it("keeps each point's time as ms since the stroke's pointerdown", () => {
    const [s] = replayStrokes(rec).strokes;
    const ts = points(s.data).map((p) => p[5]);
    expect(ts[0]).toBe(0);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    // 200 ms at 240 Hz.
    expect(ts[ts.length - 1]).toBe(200);
    expect(recordingStats(rec).penIntervalMs).toBeCloseTo(1000 / 240, 2);
  });

  it("plays back at the recorded times, scaled by speed", () => {
    for (const speed of [1, 4]) {
      let clock = 0;
      const timers: { at: number; fn: () => void }[] = [];
      const sched: Scheduler = { now: () => clock, set: (fn, ms) => timers.push({ at: clock + ms, fn }), clear: () => {} };
      const dispatchedAt: number[] = [];
      const sec = { id: rec.sections[0].id, el: { getBoundingClientRect: () => rec.events[0].rect, setPointerCapture() {} } as unknown as HTMLElement, strokes: () => [] };
      const c = new InkController("t", { kind: "pen", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {}, onInput: () => dispatchedAt.push(clock) }, { persist: false });
      const p = new PencilReplayer(rec, { controller: () => c, section: () => sec, reset() {} }, { scheduler: sched });
      p.setSpeed(speed);
      p.play();
      while (timers.length) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers.shift()!;
        clock = t.at;
        t.fn();
      }
      expect(p.state).toBe("done");
      const due = rec.events.map((e) => (e.sample.timeStamp - rec.timeOrigin) / speed);
      expect(dispatchedAt).toHaveLength(rec.events.length);
      // Never early, and no later than the timer that was due.
      dispatchedAt.forEach((t, i) => expect(t).toBeGreaterThanOrEqual(due[i] - 1e-9));
      expect(dispatchedAt[dispatchedAt.length - 1]).toBeCloseTo(due[due.length - 1], 6);
    }
  });

  it("gives replayed strokes a t0 from the recording, not the wall clock", () => {
    const a = replayStrokes(rec).strokes[0].data.t0;
    const b = replayStrokes(rec).strokes[0].data.t0;
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(Date.parse(rec.createdAt));
  });
});

describe("pressure and tilt", () => {
  it("stores pressure, altitude and azimuth from each sample", () => {
    const rec = simple({ strokes: [{ path: [[0, 0], [100, 0]], durationMs: 300, pressure: (u) => 0.1 + 0.8 * u, altitude: (u) => 0.4 + u, azimuth: (u) => 3 * u }] });
    const pts = points(replayStrokes(rec).strokes[0].data);
    const p = pts.map((q) => q[2]);
    expect(Math.min(...p)).toBeCloseTo(0.1, 2);
    expect(Math.max(...p)).toBeCloseTo(0.9, 2);
    expect(p).toEqual([...p].sort((a, b) => a - b));
    expect(Math.min(...pts.map((q) => q[3]))).toBeCloseTo(0.4, 2);
    expect(Math.max(...pts.map((q) => q[3]))).toBeCloseTo(1.4, 2);
    expect(Math.max(...pts.map((q) => q[4]))).toBeCloseTo(3, 2);
    const m = runReplay(rec).strokes[0];
    expect(m.pressure.min).toBeCloseTo(0.1, 2);
    expect(m.altitude).toEqual({ min: 0.4, max: 1.4 });
  });

  it("a mouse stroke gets the fixed 0.5 pressure, whatever the device reported", () => {
    const { strokes } = replayStrokes(FIXTURES["synthetic-edge-cases"]());
    const mouse = strokes.find((s) => s.data.input === "mouse")!;
    expect(new Set(points(mouse.data).map((q) => q[2]))).toEqual(new Set([0.5]));
  });
});

describe("multiple strokes and sections", () => {
  it("commits strokes in writing order, each after its own pointerup", () => {
    const rec = FIXTURES["synthetic-words"]();
    const { strokes } = replayStrokes(rec);
    expect(strokes.map((s) => s.afterSeq)).toEqual(rec.events.flatMap((e, i) => (e.type === "pointerup" ? [i] : [])));
    // The dot of the i is one point, drawn as a dot.
    expect(runReplay(rec).strokes.map((m) => m.outline.kind)).toEqual(["outline", "outline", "outline", "dot", "outline", "outline"]);
  });

  it("keeps each stroke on its own section", () => {
    const rec = FIXTURES["synthetic-zoomed-two-sections"]();
    expect(replayStrokes(rec).strokes.map((s) => s.sectionId)).toEqual([...Array(4).fill("sec-a"), ...Array(6).fill("sec-b")]);
  });
});

describe("cancellation, lost capture and rejected input", () => {
  const rec = FIXTURES["synthetic-edge-cases"]();
  const r = runReplay(rec);

  it("records every gesture, including the ones that are not ink", () => {
    expect(r.recording.gestures).toEqual({ downs: 7, ups: 5, cancels: 1, lostCaptures: 1 });
    expect(r.recording.events.byPointerType.touch).toBeGreaterThan(0);
  });

  it("pointercancel keeps what was drawn, without the cancel sample", () => {
    const { strokes } = replayStrokes(rec);
    const cancelled = strokes[0].data;
    expect(points(cancelled).every((q) => q[2] > 0)).toBe(true);
    const cancelSeq = rec.events.findIndex((e) => e.type === "pointercancel");
    expect(strokes[0].afterSeq).toBe(cancelSeq);
  });

  it("lost capture ends the stroke there; the late pointerup adds nothing", () => {
    const lostSeq = rec.events.findIndex((e) => e.type === "lostpointercapture");
    expect(r.strokes[1].afterSeq).toBe(lostSeq);
  });

  it("a finger is never ink, a light bounce is discarded, an open stroke is still kept", () => {
    expect(r.strokes.map((s) => s.input)).toEqual(["pen", "pen", "pen", "mouse", "pen"]);
    expect(r.discarded).toEqual({ count: 1, points: [1] });
    expect(r.strokes[4].afterSeq).toBe(rec.events.length - 1);
  });
});

describe("coalesced and predicted samples", () => {
  const rec = FIXTURES["synthetic-words"]();

  it("uses every coalesced sample; without them only the dispatched moves are stored", () => {
    const all = runReplay(rec);
    const dispatchedOnly = runReplay(rec, { useCoalesced: false });
    expect(dispatchedOnly.totals.points).toBeLessThan(all.totals.points / 3);
    expect(dispatchedOnly.totals.strokes).toBe(all.totals.strokes);
    expect(all.recording.samples.coalesced).toBeGreaterThan(all.recording.samples.dispatched);
  });

  it("predicted samples never reach the stored stroke", () => {
    const rec2 = FIXTURES["synthetic-edge-cases"]();
    expect(runReplay(rec2, { usePredicted: false }).fingerprint).toBe(runReplay(rec2).fingerprint);
    expect(runReplay(rec, { usePredicted: false }).fingerprint).toBe(runReplay(rec).fingerprint);
    // Predictions far off the line (as at a sharp turn) still change nothing that is stored.
    const wild = JSON.parse(serializeRecording(rec)) as PencilRecording;
    for (const e of wild.events) for (const p of e.predicted ?? []) p.clientX += 500;
    expect(runReplay(wild).fingerprint).toBe(runReplay(rec).fingerprint);
    expect(runReplay(rec).recording.samples.predicted).toBeGreaterThan(0);
  });
});

describe("file round trip and validation", () => {
  const rec = FIXTURES["synthetic-edge-cases"]();

  it("parse(serialize(r)) is r, frozen, and replays identically", () => {
    const parsed = parseRecording(serializeRecording(rec));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.recording).toEqual(rec);
    expect(Object.isFrozen(parsed.recording.events[0].sample)).toBe(true);
    expect(baselineOf(runReplay(parsed.recording))).toEqual(baselineOf(runReplay(rec)));
    expect(recordingFileName(rec)).toMatch(/^pencil-synthetic-edge-cases-2026-01-01-00-00-00\.json$/);
  });

  const broken = (f: (r: PencilRecording & Record<string, unknown>) => void) => {
    const r = JSON.parse(serializeRecording(rec));
    f(r);
    const out = validateRecording(r);
    return out.ok ? [] : out.errors;
  };

  it("rejects files that aren't recordings, or another version", () => {
    expect(parseRecording("{nope")).toMatchObject({ ok: false });
    expect(parseRecording(JSON.stringify({ hello: 1 })).ok).toBe(false);
    expect(broken((r) => (r.version = 99 as 1))[0]).toMatch(/version/);
    expect(parseRecording(" ".repeat(MAX_RECORDING_BYTES + 1)).ok).toBe(false);
  });

  it("names the field that is wrong", () => {
    expect(broken((r) => (r.events[3].sample.pressure = 1.5))[0]).toMatch(/^events\[3\]\.sample\.pressure/);
    expect(broken((r) => ((r.events[2].sample as { clientX: unknown }).clientX = "12"))[0]).toMatch(/^events\[2\]\.sample\.clientX/);
    expect(broken((r) => (r.events[4].seq = 9))[0]).toMatch(/events\[4\]\.seq/);
    expect(broken((r) => (r.events[0].section = "missing"))[0]).toMatch(/not listed in sections/);
    expect(broken((r) => (r.events[1].kind = "down"))[0]).toMatch(/doesn't match/);
    expect(broken((r) => (r.committed![0].afterSeq = 1e6))[0]).toMatch(/past the last event/);
  });

  it("keeps the synthetic label on generated files", () => {
    expect(rec.source).toBe("synthetic");
    expect(rec.label).toMatch(/^SYNTHETIC/);
  });
});

describe("coordinate context", () => {
  const strokes = letterPaths("ah", 300, 200).map((path) => ({ path, durationMs: path.length === 1 ? 70 : 200 }));

  it("writing at another zoom and scroll position stores the same section coordinates", () => {
    const plain = replayStrokes(synthesize({ label: "plain", strokes })).strokes;
    const moved = replayStrokes(synthesize({ label: "moved", strokes, zoom: 0.6, rect: { left: 333.3, top: -812.7 } })).strokes;
    expect(moved.length).toBe(plain.length);
    moved.forEach((s, i) => {
      const a = points(plain[i].data);
      const b = points(s.data);
      expect(b.length).toBe(a.length);
      b.forEach((q, j) => {
        expect(q[0]).toBeCloseTo(a[j][0], 1);
        expect(q[1]).toBeCloseTo(a[j][1], 1);
      });
    });
  });

  it("replay onto a section placed and zoomed differently keeps section coordinates", () => {
    const rec = synthesize({ label: "ctx", strokes });
    const out: StrokeData[] = [];
    const rect = { left: -50, top: 900, width: 1376 * 1.5, height: 700 * 1.5 };
    const sec: SectionHandle = { id: "live", el: { getBoundingClientRect: () => rect, setPointerCapture() {} } as unknown as HTMLElement, strokes: () => [] };
    const c = new InkController("t", { kind: "pen", penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 }, { onSelection() {}, onDragging() {}, onTextCreate() {}, onCommit: (_s, d) => out.push(d) }, { persist: false });
    c.configure(c.tool, 1.5);
    new PencilReplayer(rec, { controller: () => c, section: () => sec, reset() {} }).runToEnd();
    const headless = replayStrokes(rec).strokes;
    expect(out.length).toBe(headless.length);
    out.forEach((d, i) => points(d).forEach((q, j) => expect(q[0]).toBeCloseTo(points(headless[i].data)[j][0], 1)));
  });
});

describe("deterministic replay and regression output", () => {
  const rec = FIXTURES["synthetic-zoomed-two-sections"]();

  it("the same recording always gives the same report (performance aside)", () => {
    const a = runReplay(rec);
    const b = runReplay(JSON.parse(serializeRecording(rec)));
    expect(baselineOf(b)).toEqual(baselineOf(a));
    expect(a.capture).toEqual({ matches: true, differences: [] });
    expect(a.performance.note).toMatch(/not touch-to-ink latency/);
  });

  it("a writing change shows up as measurable differences", () => {
    const base = runReplay(rec);
    const changed = runReplay(rec, { pen: { positionSigma: 0, maxPointGap: 0.5 } });
    expect(changed.outlineFingerprint).not.toBe(base.outlineFingerprint);
    const diff = compareBaselines(JSON.parse(JSON.stringify(baselineOf(base))), JSON.parse(JSON.stringify(baselineOf(changed))));
    expect(diff.some((d) => /strokes\[\d+\]\.processed\.points/.test(d))).toBe(true);
    // Comparing to the capture only makes sense when replaying as recorded.
    expect(changed.capture).toBeNull();
  });

  it("a changed recording no longer matches what was committed when it was made", () => {
    const r = JSON.parse(serializeRecording(rec)) as PencilRecording;
    r.events[5].sample.clientX += 3;
    if (r.events[5].coalesced) r.events[5].coalesced[r.events[5].coalesced.length - 1].clientX += 3;
    const report = runReplay(r);
    expect(report.capture?.matches).toBe(false);
    expect(report.capture?.differences[0]).toMatch(/stroke 0: point \d+ field 0/);
  });
});
