"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InkController, type SectionHandle, type ToolState } from "@/ink/controller";
import { legacyOverrides } from "@/ink/pen-feel";
import { PencilRecorder } from "@/ink/recorder";
import { parseRecording, recordingFileName, serializeRecording, type PencilRecording } from "@/ink/recording";
import { strokeSvgPath } from "@/ink/render";
import { PencilReplayer, type ReplayState } from "@/ink/replay";
import { runReplay, type ReplayReport } from "@/ink/replay-harness";
import { usePencilNoScroll } from "@/lib/hooks";
import { downloadFile } from "@/lib/download";
import { PAGE_WIDTH, type StrokeData } from "@/lib/types";
import { Icon } from "./Icons";

// The Pencil lab (/pencil-lab): write on one page-wide surface through the real InkController
// with your notebook pen settings, record what reached the controller, save it as a file, load a
// file back, and replay it onto the surface or measure it with the headless harness. Nothing here
// is stored in a notebook. See docs/pencil-test-handoff.md.

const SURFACE_H = 760;
const DEFAULT_TOOL: ToolState = { kind: "pen", penColor: "#111827", penSize: 3.4, hlColor: "#facc15", hlSize: 22, eraserSize: 24 };

/** The notebook's saved tool (read only: the lab never changes your pen settings). */
function storedTool(): ToolState {
  try {
    const raw = localStorage.getItem("padsync.tool");
    if (!raw) return DEFAULT_TOOL;
    const { penSmoothing, penSensitivity, ...rest } = JSON.parse(raw) as ToolState;
    return { ...DEFAULT_TOOL, ...rest, kind: "pen", pen: rest.pen ?? legacyOverrides(penSmoothing, penSensitivity) };
  } catch {
    return DEFAULT_TOOL;
  }
}

interface Shown {
  id: string;
  data: StrokeData;
}

export default function PencilLab() {
  const [tool, setTool] = useState<ToolState>(storedTool);
  const [zoom, setZoom] = useState(1);
  const [strokes, setStrokes] = useState<Shown[]>([]);
  const [recording, setRecording] = useState<PencilRecording | null>(null);
  const [recorder, setRecorder] = useState<PencilRecorder | null>(null);
  const [events, setEvents] = useState(0);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [replay, setReplay] = useState<{ state: ReplayState; position: number; length: number } | null>(null);
  const [speed, setSpeed] = useState(1);

  const surfaceRef = useRef<HTMLDivElement>(null);
  usePencilNoScroll(surfaceRef);
  const [lab] = useState(() => new LabSession({ onEvents: setEvents, onStroke: (s) => setStrokes((all) => [...all, s]) }));
  const controller = lab.controller;

  const handle = useMemo<SectionHandle>(
    () => ({
      id: "lab",
      get el() {
        return surfaceRef.current!;
      },
      strokes: () => [],
    }),
    [],
  );

  // Fit the page width to the window, as the notebook does on a narrow screen.
  useLayoutEffect(() => {
    const fit = () => setZoom(Math.min(1, (window.innerWidth - 32) / PAGE_WIDTH));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useLayoutEffect(() => lab.configure(tool, zoom), [lab, tool, zoom]);
  // Committed strokes are drawn as SVG below; the overlay copy can go once they are on screen.
  useEffect(() => controller.ackPainted(strokes.map((s) => s.id)), [controller, strokes]);

  const liveRef = useCallback((c: HTMLCanvasElement | null) => lab.controller.attachLive(c), [lab]);
  useEffect(() => {
    const onResize = () => controller.resizeLive();
    const end = () => controller.endGesture();
    const vis = () => document.visibilityState === "hidden" && end();
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", end);
    window.addEventListener("pagehide", end);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", end);
      window.removeEventListener("pagehide", end);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [controller]);
  useEffect(() => () => lab.stopReplay(), [lab]);

  const stopReplay = () => {
    lab.stopReplay();
    setReplay(null);
  };

  const startRecording = () => {
    stopReplay();
    setRecorder(lab.startRecording(label || "Pencil recording"));
    setEvents(0);
    setStrokes([]);
    setErrors([]);
  };

  const stopRecording = () => {
    const rec = lab.stopRecording(notes || undefined);
    setRecorder(null);
    if (!rec) return;
    setRecording(rec);
    setReport(runReplay(rec));
  };

  const save = () => {
    if (!recording) return;
    downloadFile(recordingFileName(recording), serializeRecording(recording), "application/json");
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    stopReplay();
    const parsed = parseRecording(await file.text());
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setRecording(parsed.recording);
    setLabel(parsed.recording.label);
    setNotes(parsed.recording.notes ?? "");
    setStrokes([]);
    setReport(runReplay(parsed.recording));
  };

  /** Replays the current recording onto the surface, at the recorded pace × speed (0: at once). */
  const play = (at: number) => {
    if (!recording) return;
    stopReplay();
    setStrokes([]);
    lab.play(recording, handle, at, () => setStrokes([]), (state, position, length) => setReplay({ state, position, length }));
  };

  const recordingNow = recorder !== null;
  const playing = replay?.state === "playing";
  const paused = replay?.state === "paused";

  return (
    <main className="px-4 pb-16 pt-4 text-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/settings" className="btn btn-ghost -ml-2 px-2"><Icon name="back" className="text-lg" />Settings</Link>
        <h1 className="mr-auto text-xl font-semibold text-slate-900">Pencil lab</h1>
        <div className="segmented" role="group" aria-label="Tool">
          {(["pen", "highlighter"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={tool.kind === k} onClick={() => setTool({ ...tool, kind: k })}>{k === "pen" ? "Pen" : "Highlighter"}</button>
          ))}
        </div>
        {recordingNow ? (
          <button type="button" className="btn btn-primary" onClick={stopRecording}>Stop ({events} events)</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={startRecording} disabled={playing}>Record</button>
        )}
        <button type="button" className="btn btn-secondary" onClick={save} disabled={!recording || recordingNow}>Save file</button>
        <label className="btn btn-secondary cursor-pointer">
          Load file
          <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => void load(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => (playing ? lab.pause() : paused ? lab.resume() : play(speed))} disabled={!recording || recordingNow}>{playing ? "Pause" : paused ? "Resume" : "Replay"}</button>
        <select className="btn btn-secondary" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
          {[0.25, 1, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <button type="button" className="btn btn-secondary" onClick={() => play(0)} disabled={!recording || recordingNow}>Replay at once</button>
        <button type="button" className="btn btn-ghost" onClick={() => { stopReplay(); setStrokes([]); }} disabled={recordingNow}>Clear</button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input min-w-48 flex-1 rounded border border-slate-300 px-2 py-1" placeholder="Label (what you wrote, e.g. “alphabet, light pressure”)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={recordingNow} />
        <input className="input min-w-48 flex-[2] rounded border border-slate-300 px-2 py-1" placeholder="Notes (device, Pencil model, what looked wrong)" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={recordingNow} />
      </div>
      {errors.length > 0 && (
        <div className="card mb-3 border-red-300 p-3 text-red-700" role="alert">
          <p className="font-medium">Not a usable recording:</p>
          <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="shrink-0" style={{ width: PAGE_WIDTH * zoom, height: SURFACE_H * zoom }}>
        <section className="paper template-dots relative bg-white shadow" style={{ width: PAGE_WIDTH, height: SURFACE_H, transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: "0 0" }}>
          <svg className="pointer-events-none absolute inset-0" width={PAGE_WIDTH} height={SURFACE_H} viewBox={`0 0 ${PAGE_WIDTH} ${SURFACE_H}`}>
            {strokes.map((s) => (
              <path key={s.id} d={strokeSvgPath(s.data)} fill={s.data.color} opacity={s.data.tool === "highlighter" ? 0.32 : 1} style={s.data.tool === "highlighter" ? { mixBlendMode: "multiply" } : undefined} />
            ))}
          </svg>
          <div
            ref={surfaceRef}
            className="ink-surface absolute inset-0"
            style={{ cursor: "crosshair" }}
            onPointerDown={(e) => controller.down(e.nativeEvent, handle)}
            onPointerMove={(e) => controller.move(e.nativeEvent, handle)}
            onPointerUp={(e) => controller.up(e.nativeEvent, handle)}
            onPointerCancel={(e) => controller.up(e.nativeEvent, handle)}
            onLostPointerCapture={(e) => controller.lostCapture(e.nativeEvent, handle)}
            onPointerLeave={() => controller.leave()}
          />
        </section>
      </div>
      <canvas ref={liveRef} className="pointer-events-none fixed left-0 top-0 z-30" />

      <p className="mt-2 text-xs text-slate-500">
        {recordingNow ? "Recording what reaches the ink controller. " : ""}
        {replay ? `Replay ${replay.state}: event ${replay.position} of ${replay.length}. ` : ""}
        Uses your notebook pen settings; nothing written here is saved to a notebook.
      </p>

      {report && <ReportCard report={report} />}
    </main>
  );
}

/**
 * The lab's controller, recorder and replayer: mutable session state the page drives but doesn't
 * render, kept out of React state and refs.
 */
class LabSession {
  readonly controller: InkController;
  private recorder: PencilRecorder | null = null;
  private replayer: PencilReplayer | null = null;
  private tool: ToolState = DEFAULT_TOOL;

  constructor(ui: { onEvents: (n: number) => void; onStroke: (s: Shown) => void }) {
    this.controller = new InkController(
      "pencil-lab",
      DEFAULT_TOOL,
      {
        onSelection() {},
        onDragging() {},
        onTextCreate() {},
        onInput: (kind, e, sec) => {
          // Replayed input is not recorded again.
          if (!this.recorder || this.replayer) return;
          this.recorder.input(kind, e, sec);
          ui.onEvents(this.recorder.size);
        },
        onCommit: (sectionId, data, id) => {
          if (!this.replayer) this.recorder?.commit(sectionId, data);
          ui.onStroke({ id, data });
        },
      },
      { persist: false },
    );
  }

  configure(tool: ToolState, zoom: number) {
    this.tool = tool;
    this.controller.configure(tool, zoom);
  }

  startRecording(label: string) {
    this.recorder = new PencilRecorder({ label, source: "device", state: () => ({ tool: this.controller.tool, zoom: this.controller.zoom }) });
    return this.recorder;
  }

  stopRecording(notes?: string): PencilRecording | null {
    const r = this.recorder;
    if (!r) return null;
    this.controller.endGesture();
    this.recorder = null;
    return r.finish(notes);
  }

  play(rec: PencilRecording, sec: SectionHandle, speed: number, reset: () => void, onChange: (s: ReplayState, position: number, length: number) => void) {
    const p: PencilReplayer = new PencilReplayer(
      rec,
      { controller: () => this.controller, section: () => sec, reset },
      {
        onChange: () => {
          onChange(p.state, p.position, p.length);
          if (p.state !== "done") return;
          // Replay applies the recorded tool; writing afterwards uses yours again.
          this.controller.endGesture();
          this.controller.configure(this.tool, this.controller.zoom);
          this.replayer = null;
        },
      },
    );
    this.replayer = p;
    if (speed === 0) p.runToEnd();
    else {
      p.setSpeed(speed);
      p.play();
    }
  }

  pause() {
    this.replayer?.pause();
  }

  resume() {
    this.replayer?.play();
  }

  stopReplay() {
    this.replayer?.dispose();
    this.replayer = null;
    this.controller.endGesture();
    this.controller.configure(this.tool, this.controller.zoom);
  }
}

function ReportCard({ report: r }: { report: ReplayReport }) {
  const [copied, setCopied] = useState(false);
  const rows: [string, string][] = [
    ["Recording", `${r.recording.label} (${r.recording.source})`],
    ["Events", `${r.recording.events.total}: ${Object.entries(r.recording.events.byType).map(([k, v]) => `${k} ${v}`).join(", ")}`],
    ["Samples", `${r.recording.samples.dispatched} dispatched, ${r.recording.samples.coalesced} coalesced, ${r.recording.samples.predicted} predicted`],
    ["Pen sample interval", r.recording.penIntervalMs === null ? "—" : `${r.recording.penIntervalMs} ms median (browser timestamps)`],
    ["Gestures", `${r.recording.gestures.downs} down, ${r.recording.gestures.ups} up, ${r.recording.gestures.cancels} cancelled, ${r.recording.gestures.lostCaptures} lost capture`],
    ["Strokes", `${r.totals.strokes} kept (${r.totals.points} points → ${r.totals.processedPoints} after clean-up), ${r.discarded.count} discarded`],
    ["Fingerprints", `ink ${r.fingerprint}, outline ${r.outlineFingerprint}`],
    ["Replay vs capture", r.capture ? (r.capture.matches ? "identical" : `${r.capture.differences.length} differences: ${r.capture.differences[0]}`) : "—"],
    ["Pipeline CPU time", `${r.performance.replayMs} ms replay + ${r.performance.renderMs} ms outlines, this device (not touch-to-ink latency)`],
  ];
  return (
    <section className="card mt-4 max-w-3xl p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Headless replay report</h2>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(r, null, 1)).then(() => setCopied(true), () => {})}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
