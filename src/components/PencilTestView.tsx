"use client";

import Link from "next/link";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isStrayDot, type Contact } from "@/ink/filters";
import { legacyOverrides, penOverrides, withOverrides, type PenParams } from "@/ink/pen-feel";
import { attachInputCapture, captureEnvironment, detectApis, surfaceTransform } from "@/ink/recording/capture";
import { PencilRecorder } from "@/ink/recording/recorder";
import { parseRecording, recordingFileName, serializeRecording, type Capabilities, type PencilRecording, type RecordingStats, type RecordingTool, type SampleField } from "@/ink/recording/schema";
import { paintStroke, strokePath } from "@/ink/render";
import { appendPoint, toLocal } from "@/ink/samples";
import { deviceId } from "@/lib/db";
import { usePencilNoScroll } from "@/lib/hooks";
import { PAGE_WIDTH, type StrokeData } from "@/lib/types";
import { Icon } from "./Icons";

// The Pencil test page: write on a page-sized surface, record every input event the browser
// delivers (recording/), and save it as a JSON file for replay and tests. Ink on the surface is
// drawn exactly as a notebook section draws it: same palm rejection, coordinate mapping, point
// storage (samples.ts), stray-dot filter, outline and the pen settings in use on this device.
// Nothing here is saved to notebooks or synced.

const PAGE_HEIGHT = 720;

interface Gesture {
  data: StrokeData;
  predicted: number[];
  contact: Contact;
  t0: number;
  rect: DOMRect;
  pointerId: number;
}

interface Committed {
  data: StrokeData;
  path: Path2D;
}

/** The pen as the notebook editor has it on this device (padsync.tool), for an identical stroke. */
function storedPen(): { color: string; size: number; params: PenParams } {
  let t: { penColor?: string; penSize?: number; pen?: Partial<PenParams>; penSmoothing?: number; penSensitivity?: number } = {};
  try {
    t = JSON.parse(localStorage.getItem("padsync.tool") ?? "{}");
  } catch { /* defaults */ }
  return { color: t.penColor ?? "#111827", size: t.penSize ?? 3.4, params: withOverrides(t.pen ?? legacyOverrides(t.penSmoothing, t.penSensitivity)) };
}

const round = (v: number, f: number) => Math.round(v * f) / f;

export default function PencilTestView() {
  const [pen] = useState(storedPen);
  const [recorder] = useState(() => new PencilRecorder());
  // performance.now() at the last feedback refresh: the recording's duration so far.
  const [now, setNow] = useState(0);
  const [label, setLabel] = useState("");
  const [expected, setExpected] = useState("");
  const [showSamples, setShowSamples] = useState(true);
  const [loaded, setLoaded] = useState<{ name: string; rec: PencilRecording } | { name: string; error: string } | null>(null);
  const [inkCount, setInkCount] = useState({ strokes: 0, dropped: 0 });

  const rootRef = useRef<HTMLElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  usePencilNoScroll(surfaceRef);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const gesture = useRef<Gesture | null>(null);
  const strokes = useRef<Committed[]>([]);
  // Surface-local positions of observed (coalesced) and predicted samples, for the sample overlay.
  const observedPts = useRef<number[]>([]);
  const predictedPts = useRef<number[]>([]);
  const frame = useRef(0);
  const showSamplesRef = useRef(showSamples);

  const tool: RecordingTool = { tool: "pen", color: pen.color, size: pen.size, pen: penOverrides(pen.params) as RecordingTool["pen"] };

  const transform = useCallback(() => surfaceTransform(surfaceRef.current, zoomRef.current, PAGE_WIDTH, PAGE_HEIGHT, canvasRef.current), []);

  // Fit the page to the width available, like the notebook's fit zoom (never above 1).
  useLayoutEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const z = Math.min(1, el.clientWidth / PAGE_WIDTH);
      zoomRef.current = z;
      setZoom(z);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const scale = c.width / PAGE_WIDTH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const s of strokes.current) paintStroke(ctx, s.data, s.path);
    const g = gesture.current;
    if (g?.data.pts.length) {
      const data = g.predicted.length ? { ...g.data, pts: g.data.pts.concat(g.predicted) } : g.data;
      paintStroke(ctx, data, strokePath(data));
    }
    if (showSamplesRef.current) {
      const dots = (pts: number[], color: string, r: number) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          ctx.moveTo(pts[i] + r, pts[i + 1]);
          ctx.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
        }
        ctx.fill();
      };
      dots(predictedPts.current, "rgba(234,88,12,0.55)", 1.6);
      dots(observedPts.current, "rgba(37,99,235,0.75)", 1.1);
    }
  }, []);

  const requestFrame = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw();
    });
  }, [draw]);

  // Backing store at the zoom shown, capped like ink tiles (2.95× keeps it under 4096 px wide).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = Math.min((window.devicePixelRatio || 1) * zoom, 2.95);
    c.width = Math.round(PAGE_WIDTH * scale);
    c.height = Math.round(PAGE_HEIGHT * scale);
    requestFrame();
  }, [zoom, requestFrame]);

  useEffect(() => {
    showSamplesRef.current = showSamples;
    requestFrame();
  }, [showSamples, requestFrame]);

  useEffect(() => attachInputCapture(recorder, { root: () => rootRef.current, surface: () => surfaceRef.current, transform }), [recorder, transform]);

  // Feedback refresh: a few times a second, only when the recorder changed.
  useEffect(() => {
    let seen = -1;
    const id = setInterval(() => {
      if (recorder.version !== seen || recorder.recording) {
        seen = recorder.version;
        setNow(performance.now());
      }
    }, 250);
    return () => clearInterval(id);
  }, [recorder]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Preview ink: the controller's pen path (InkController.down/move/up), without storage.
  const addPoints = (g: Gesture, evs: PointerEvent[]) => {
    for (const ev of evs) {
      g.contact.durationMs = Math.max(g.contact.durationMs, ev.timeStamp - g.t0);
      if (ev.pointerType === "pen") g.contact.maxPressure = Math.max(g.contact.maxPressure, ev.pressure);
      const [x, y] = toLocal(ev.clientX, ev.clientY, g.rect, zoomRef.current);
      appendPoint(g.data.pts, x, y, ev, g.t0, pen.params.dropOutOfOrder);
      observedPts.current.push(x, y);
    }
  };

  const end = (g: Gesture, last: PointerEvent | null) => {
    gesture.current = null;
    if (last) addPoints(g, [last]);
    if (g.data.pts.length && !isStrayDot(g.data, g.contact, pen.params)) {
      strokes.current.push({ data: g.data, path: strokePath(g.data) });
      setInkCount((c) => ({ ...c, strokes: c.strokes + 1 }));
    } else {
      setInkCount((c) => ({ ...c, dropped: c.dropped + 1 }));
    }
    requestFrame();
  };

  const onDown = (e: React.PointerEvent) => {
    const ev = e.nativeEvent;
    // Fingers are never ink (palm rejection); their touches are still recorded.
    if (ev.pointerType === "touch" || (ev.pointerType === "mouse" && ev.button !== 0)) return;
    if (gesture.current) end(gesture.current, null);
    ev.preventDefault();
    try {
      e.currentTarget.setPointerCapture(ev.pointerId);
    } catch { /* already gone */ }
    const data: StrokeData = { tool: "pen", color: pen.color, size: pen.size, pts: [], t0: Date.now(), input: ev.pointerType, device: deviceId(), ...(Object.keys(tool.pen).length ? { pen: tool.pen } : {}) };
    const g: Gesture = { data, predicted: [], contact: { durationMs: 0, maxPressure: 0 }, t0: ev.timeStamp, rect: e.currentTarget.getBoundingClientRect(), pointerId: ev.pointerId };
    gesture.current = g;
    addPoints(g, [ev]);
    requestFrame();
  };

  const onMove = (e: React.PointerEvent) => {
    const ev = e.nativeEvent;
    const g = gesture.current;
    if (!g || ev.pointerId !== g.pointerId) return;
    if (ev.buttons === 0) return end(g, null);
    const coalesced = ev.getCoalescedEvents?.() ?? [];
    addPoints(g, coalesced.length ? coalesced : [ev]);
    const pts = g.data.pts;
    const lastP = pts[pts.length - 4];
    const lastT = pts[pts.length - 1];
    g.predicted = [];
    for (const p of (ev.getPredictedEvents?.() ?? []).slice(0, pen.params.maxPredicted)) {
      const [x, y] = toLocal(p.clientX, p.clientY, g.rect, zoomRef.current);
      g.predicted.push(round(x, 100), round(y, 100), lastP, 0, 0, lastT);
      predictedPts.current.push(x, y);
    }
    requestFrame();
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (g && e.nativeEvent.pointerId === g.pointerId) end(g, e.type === "pointercancel" ? null : e.nativeEvent);
  };

  const clearInk = () => {
    if (gesture.current) gesture.current = null;
    strokes.current = [];
    observedPts.current = [];
    predictedPts.current = [];
    setInkCount({ strokes: 0, dropped: 0 });
    requestFrame();
  };

  const start = () => {
    clearInk();
    setLoaded(null);
    recorder.start({
      id: nanoid(),
      createdAt: new Date().toISOString(),
      timeOrigin: performance.timeOrigin,
      now: performance.now(),
      environment: captureEnvironment(),
      apis: detectApis(),
      tool,
      transform: transform(),
      label: label.trim(),
      expectedText: expected,
    });
  };

  const stop = () => recorder.stop(performance.now());

  const reset = () => {
    recorder.reset();
    clearInk();
    setLoaded(null);
  };

  const clearPage = () => {
    if (recorder.recording) recorder.marker("surface-reset", performance.now(), performance.now(), { strokes: strokes.current.length }, transform());
    clearInk();
  };

  const save = () => {
    const rec = recorder.toRecording();
    const blob = new Blob([serializeRecording(rec)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = recordingFileName(rec);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const open = async (file: File) => {
    try {
      setLoaded({ name: file.name, rec: parseRecording(await file.text()) });
    } catch (err) {
      setLoaded({ name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const state = recorder.state;
  const stats = state === "idle" ? null : recorder.stats(now);
  const caps = state === "idle" ? null : recorder.capabilities();
  const last = recorder.last;

  return (
    <main ref={rootRef} className="mx-auto max-w-[1440px] px-3 pb-16 pt-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/settings" className="icon-btn" aria-label="Back to settings" title="Back"><Icon name="back" className="text-lg" /></Link>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Pencil test</h1>
        <StatusPill state={state} durationMs={stats?.durationMs ?? 0} truncated={recorder.isTruncated()} />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {state === "recording" ? (
            <button className="btn btn-danger" onClick={stop}><Icon name="stop" />Stop</button>
          ) : (
            <button className="btn btn-primary" onClick={start}>{state === "stopped" ? "Record again" : "Start recording"}</button>
          )}
          <button className="btn btn-secondary" disabled={state !== "stopped"} onClick={save} title="Save the recording as a JSON file"><Icon name="download" />Save</button>
          <button className="btn btn-ghost" onClick={clearPage} title="Clear the ink; a recording keeps going and notes the clear">Clear page</button>
          <button className="btn btn-ghost" onClick={reset} title="Discard the recording and the ink"><Icon name="refresh" />Reset</button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} title="Check a saved recording file"><Icon name="upload" />Open…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void open(f); }} />
        </div>
      </header>

      <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="min-w-48 flex-1">
          <span className="mb-1 block text-xs text-slate-500">Label (file name)</span>
          <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. cursive-sentence" disabled={state === "recording"} />
        </label>
        <label className="min-w-48 flex-[2]">
          <span className="mb-1 block text-xs text-slate-500">What you will write (for tests)</span>
          <input className="field" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="e.g. The quick brown fox" disabled={state === "recording"} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-slate-600">
          <input type="checkbox" checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} />
          Show samples <span className="text-xs text-slate-400">(<span className="text-blue-600">observed</span> · <span className="text-orange-600">predicted</span>)</span>
        </label>
      </div>

      <div ref={holderRef} className="mb-4 w-full">
        <div style={{ width: PAGE_WIDTH * zoom, height: PAGE_HEIGHT * zoom }}>
          <section
            className="paper template-lines relative bg-white shadow-[0_1px_3px_rgb(15_23_42/0.08),0_8px_24px_-8px_rgb(15_23_42/0.12)]"
            style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: "0 0" }}
          >
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }} />
            <div
              ref={surfaceRef}
              data-testid="pencil-surface"
              className="ink-surface absolute inset-0"
              style={{ cursor: "crosshair" }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onLostPointerCapture={(e) => { const g = gesture.current; if (g && e.nativeEvent.pointerId === g.pointerId) end(g, null); }}
            />
          </section>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Capture</h2>
          {stats ? <StatsList stats={stats} ink={inkCount} /> : <p className="text-sm text-slate-500">Start recording, then write on the page. Ink shows either way; only a recording keeps the events.</p>}
          <Warnings stats={stats} caps={caps} />
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Last sample {last && <span className="font-normal text-slate-500">· {last.pointerType} {last.type} #{last.pointerId}</span>}</h2>
          {last ? <LastSampleList values={last.values} /> : <p className="text-sm text-slate-500">No pointer input recorded yet.</p>}
        </section>
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Capabilities</h2>
          {caps ? <CapabilityTable caps={caps} /> : <ApiList apis={detectApis()} />}
        </section>
      </div>

      {loaded && (
        <section className="card mt-4 p-4 text-sm">
          <h2 className="mb-2 font-semibold text-slate-900">File: {loaded.name}</h2>
          {"error" in loaded ? (
            <p className="text-rose-700">{loaded.error}</p>
          ) : (
            <>
              <p className="mb-2 text-emerald-700">Valid recording, format version {loaded.rec.version}{loaded.rec.label ? ` · “${loaded.rec.label}”` : ""}{loaded.rec.truncated ? " · truncated" : ""}. Replay is not built yet.</p>
              <StatsList stats={loaded.rec.stats} />
              <div className="mt-3"><CapabilityTable caps={loaded.rec.capabilities} /></div>
            </>
          )}
        </section>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Recorded are the browser&rsquo;s pointer and touch events, not sensor data from the Pencil: positions, pressure and angles are what this browser exposes after its own processing, and which fields carry values depends on the browser, iPadOS and the Pencil model. Fields the browser does not provide are saved as empty (null), never filled in. Predicted samples are the browser&rsquo;s guesses and are kept apart from observed input.
      </p>
    </main>
  );
}

function StatusPill({ state, durationMs, truncated }: { state: string; durationMs: number; truncated: boolean }) {
  const s = Math.floor(durationMs / 1000);
  const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (state === "recording") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 text-sm font-medium text-rose-700" role="status">
        <span className="size-2 animate-pulse rounded-full bg-rose-500" />Recording {time}{truncated ? " · limit reached" : ""}
      </span>
    );
  }
  return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm text-slate-600" role="status">{state === "stopped" ? `Stopped · ${time}` : "Not recording"}</span>;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-mono tabular-nums text-slate-800">{v}</dd>
    </>
  );
}

function StatsList({ stats, ink }: { stats: RecordingStats; ink?: { strokes: number; dropped: number } }) {
  const hz = stats.penIntervalMs ? Math.round(1000 / stats.penIntervalMs) : null;
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
      <Row k="Events" v={stats.events} />
      <Row k="Pointer / touch" v={`${stats.pointerEvents} / ${stats.touchEvents}`} />
      <Row k="Coalesced samples" v={stats.coalescedSamples} />
      <Row k="Predicted samples" v={stats.predictedSamples} />
      <Row k="Strokes started" v={stats.strokes} />
      {ink && <Row k="Ink kept / dropped" v={`${ink.strokes} / ${ink.dropped}`} />}
      <Row k="Cancels" v={stats.cancels} />
      <Row k="Pen sample interval" v={stats.penIntervalMs ? `${stats.penIntervalMs.toFixed(1)} ms (~${hz} Hz)` : "—"} />
      <Row k="By pointer type" v={Object.entries(stats.byPointerType).map(([k, n]) => `${k} ${n}`).join(", ") || "—"} />
    </dl>
  );
}

const LAST_FIELDS: SampleField[] = ["pressure", "tiltX", "tiltY", "altitudeAngle", "azimuthAngle", "twist", "tangentialPressure", "width", "height", "buttons", "clientX", "clientY", "timeStamp"];

function LastSampleList({ values }: { values: Partial<Record<SampleField, number | null>> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
      {LAST_FIELDS.map((f) => {
        const v = values[f];
        return <Row key={f} k={f} v={v === null || v === undefined ? <span className="text-slate-400">n/a</span> : Number.isInteger(v) ? v : v.toFixed(3)} />;
      })}
    </dl>
  );
}

function CapabilityTable({ caps }: { caps: Capabilities }) {
  const types = Object.entries(caps.pointerTypes);
  return (
    <div className="text-sm">
      {types.length ? types.map(([type, t]) => (
        <details key={type} open={type === "pen"} className="mb-2">
          <summary className="cursor-pointer text-slate-700">{type} · {t.samples} observed samples</summary>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {Object.entries(t.fields).map(([f, s]) => (
              <li key={f} className="flex justify-between gap-2">
                <span className="text-slate-500">{f}</span>
                <span className={s.status === "varies" ? "text-emerald-700" : s.status === "constant" ? "text-amber-700" : "text-slate-400"}>
                  {s.status === "varies" ? `${fmt(s.min)}…${fmt(s.max)}` : s.status === "constant" ? `always ${fmt(s.value)}` : "unavailable"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )) : <p className="mb-2 text-slate-500">No pointer input yet.</p>}
      <p className="mb-1 text-xs text-slate-500">Touch events reported a stylus: {caps.stylusTouchSeen ? "yes" : "no"}</p>
      <ApiList apis={caps.apis} />
    </div>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function ApiList({ apis }: { apis: Record<string, boolean> }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-slate-600">Browser APIs</summary>
      <ul className="mt-1 grid grid-cols-2 gap-x-3">
        {Object.entries(apis).map(([k, v]) => <li key={k} className={v ? "text-slate-700" : "text-slate-400"}>{v ? "✓" : "✗"} {k}</li>)}
      </ul>
    </details>
  );
}

function Warnings({ stats, caps }: { stats: RecordingStats | null; caps: Capabilities | null }) {
  if (!stats || !caps) return null;
  const notes: string[] = [];
  if (stats.strokes && !stats.byPointerType.pen) notes.push("No pen input yet: Apple Pencil reports pointerType “pen”. Mouse and trackpad strokes are recorded but are not Pencil data.");
  if (stats.cancels) notes.push(`The browser cancelled ${stats.cancels} pointer${stats.cancels === 1 ? "" : "s"} (Scribble, a system gesture or palm handling).`);
  if (!caps.apis.getCoalescedEvents) notes.push("getCoalescedEvents is missing: only one sample per event is available.");
  if (caps.penUnavailable.length) notes.push(`Pen fields this browser leaves empty: ${caps.penUnavailable.join(", ")}.`);
  if (!notes.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-xs text-amber-800">
      {notes.map((n) => <li key={n} className="flex gap-1.5"><Icon name="alert" className="mt-0.5 shrink-0" />{n}</li>)}
    </ul>
  );
}
