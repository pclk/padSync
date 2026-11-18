"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InkController, type SectionHandle, type ToolState } from "@/ink/controller";
import { withOverrides } from "@/ink/pen-feel";
import { PencilRecorder } from "@/ink/recorder";
import { parseRecording, recordingDuration, recordingFileName, serializeRecording, type PencilRecording } from "@/ink/recording";
import { diffStrokes, PencilReplayer, replayHeadless } from "@/ink/replay";
import { paintStroke, strokePath } from "@/ink/render";
import { PAGE_WIDTH, type StrokeData } from "@/lib/types";

// Pencil lab: write on a scratch page while the input is recorded, save the recording as a file,
// load one and replay it through the same ink controller. Nothing here is stored in a notebook.
// See docs/pencil-test-handoff.md.

const HEIGHT = 760;
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const FALLBACK_TOOL: ToolState = { kind: "pen", penColor: "#111827", penSize: 3.4, hlColor: "#facc15", hlSize: 22, eraserSize: 24 };

/** The notebook's saved pen (colour, size, pen feel), read once; the lab never changes it. */
function savedTool(): ToolState {
  try {
    const t = JSON.parse(localStorage.getItem("padsync.tool") ?? "null") as Partial<ToolState> | null;
    if (t) return { ...FALLBACK_TOOL, ...t, kind: t.kind === "highlighter" ? "highlighter" : "pen" };
  } catch { /* default */ }
  return FALLBACK_TOOL;
}

type Mode = "idle" | "recording" | "replay";

export default function PencilLab() {
  const [tool, setTool] = useState<ToolState>(savedTool);
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<Mode>("idle");
  const [strokes, setStrokes] = useState<{ id: string; data: StrokeData }[]>([]);
  const [recording, setRecording] = useState<PencilRecording | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [check, setCheck] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<PencilRecorder | null>(null);
  const replayerRef = useRef<PencilReplayer | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

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

  // One controller per run: recording, or each replay from its start, so runs share no state.
  const [controller, setController] = useState<InkController>(() => makeController(null));
  function makeController(replayer: PencilReplayer | null): InkController {
    const c = new InkController(
      "pencil-lab",
      toolRef.current,
      {
        onSelection() {},
        onDragging() {},
        onTextCreate() {},
        onInput: (kind, e, sec) => recorderRef.current?.input(kind, e, sec),
        onCommit: (_sec, data, id) => {
          recorderRef.current?.commit(_sec, data);
          setStrokes((s) => [...s, { id, data }]);
        },
      },
      { persist: false, ...(replayer ? { now: replayer.clock } : {}) },
    );
    c.configure(toolRef.current, zoomRef.current);
    return c;
  }
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  // A replay keeps the tool its recording set; only the zoom follows the window.
  useLayoutEffect(() => controller.configure(mode === "replay" ? controller.tool : tool, zoom), [controller, tool, zoom, mode]);
  useEffect(() => {
    controller.attachLive(liveRef.current);
    const onResize = () => controller.resizeLive();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      controller.attachLive(null);
    };
  }, [controller]);

  // The page fits the window width, like the notebook on a narrower screen.
  useEffect(() => {
    const fit = () => setZoom(Math.min(1, (window.innerWidth - 32) / PAGE_WIDTH));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Committed ink: repainted whole (a lab page holds little), then the overlay copies can go.
  useEffect(() => {
    const c = inkRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(PAGE_WIDTH * zoom * dpr);
    c.height = Math.round(HEIGHT * zoom * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
    for (const s of strokes) paintStroke(ctx, s.data, strokePath(s.data));
    controller.ackPainted(strokes.map((s) => s.id));
  }, [strokes, zoom, controller]);

  useEffect(() => () => replayerRef.current?.dispose(), []);

  // `tick` re-renders on every replay step; the replayer itself is the source of truth.
  void tick;
  const replayer = replayerRef.current;

  const startRecording = () => {
    replayerRef.current?.dispose();
    replayerRef.current = null;
    setStrokes([]);
    setErrors([]);
    setCheck(null);
    setRecording(null);
    recorderRef.current = new PencilRecorder({ label: "Pencil lab", state: () => ({ tool: controllerRef.current.tool, zoom: controllerRef.current.zoom }) });
    setController(makeController(null));
    setMode("recording");
  };

  const stopRecording = () => {
    const rec = recorderRef.current;
    controllerRef.current.endGesture();
    recorderRef.current = null;
    setMode("idle");
    if (rec) {
      const r = rec.finish();
      const parsed = parseRecording(serializeRecording(r));
      if (parsed.ok) setRecording(parsed.recording);
      else setErrors(parsed.errors);
      if (rec.truncated) setErrors((e) => [...e, "The recording reached its event limit; later input was not kept."]);
    }
  };

  const loadForReplay = useCallback((r: PencilRecording) => {
    replayerRef.current?.dispose();
    const reset = () => {
      setStrokes([]);
      const c = makeController(p);
      controllerRef.current = c;
      setController(c);
    };
    const p = new PencilReplayer(r, { controller: () => controllerRef.current, section: () => (surfaceRef.current ? handle : null), reset }, { onChange: () => setTick((t) => t + 1) });
    replayerRef.current = p;
    setRecording(r);
    setMode("replay");
    p.restart();
  }, [handle]);

  const exportFile = () => {
    if (!recording) return;
    const blob = new Blob([serializeRecording(recording)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = recordingFileName(recording);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setCheck(null);
    const parsed = parseRecording(await file.text());
    if (!parsed.ok) {
      setErrors([`${file.name}:`, ...parsed.errors]);
      return;
    }
    setErrors([]);
    loadForReplay(parsed.recording);
  };

  /** Replays with no page at the recorded rect and zoom: must give exactly the recorded strokes. */
  const verify = () => {
    if (!recording) return;
    const diffs = diffStrokes(recording.committed ?? [], replayHeadless(recording, InkController));
    setCheck(diffs.length ? `Differs from the recorded strokes:\n${diffs.join("\n")}` : `Replay matches all ${recording.committed?.length ?? 0} recorded strokes exactly.`);
  };

  const live = mode !== "replay";
  const surface = live
    ? {
        onPointerDown: (e: React.PointerEvent) => controller.down(e.nativeEvent, handle),
        onPointerMove: (e: React.PointerEvent) => controller.move(e.nativeEvent, handle),
        onPointerUp: (e: React.PointerEvent) => controller.up(e.nativeEvent, handle),
        onPointerCancel: (e: React.PointerEvent) => controller.up(e.nativeEvent, handle),
        onLostPointerCapture: (e: React.PointerEvent) => controller.lostCapture(e.nativeEvent, handle),
        onPointerLeave: () => controller.leave(),
      }
    : {};

  const pen = withOverrides(tool.pen);
  return (
    <main className="min-h-screen bg-slate-100 px-4 py-4 text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className="btn btn-ghost">← Library</Link>
        <h1 className="mr-2 text-base font-semibold">Pencil lab</h1>
        {mode === "recording" ? (
          <button className="btn btn-primary" onClick={stopRecording}>■ Stop recording ({recorderRef.current?.size ?? 0} events)</button>
        ) : (
          <button className="btn" onClick={startRecording}>● Record</button>
        )}
        <button className="btn" disabled={!recording || mode === "recording"} onClick={exportFile}>Save file</button>
        <label className="btn cursor-pointer">
          Open file
          <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {recording && mode !== "recording" && mode !== "replay" && <button className="btn" onClick={() => loadForReplay(recording)}>Replay</button>}
        <span className="mx-1 h-5 w-px bg-slate-300" />
        <select className="rounded border px-2 py-1 dark:bg-slate-800" value={tool.kind} disabled={mode === "replay"} onChange={(e) => setTool({ ...tool, kind: e.target.value as ToolState["kind"] })}>
          <option value="pen">Pen</option>
          <option value="highlighter">Highlighter</option>
        </select>
        <button className="btn btn-ghost" disabled={mode !== "idle"} onClick={() => setStrokes([])}>Clear page</button>
      </div>

      {mode === "replay" && replayer && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {replayer.state === "playing" ? (
            <button className="btn btn-primary" onClick={() => replayer.pause()}>❚❚ Pause</button>
          ) : (
            <button className="btn btn-primary" onClick={() => replayer.play()}>▶ Play</button>
          )}
          <button className="btn" onClick={() => replayer.restart()}>⟲ Restart</button>
          <button className="btn" disabled={replayer.state === "playing" || replayer.state === "done"} onClick={() => replayer.step()}>Step event</button>
          <button className="btn" disabled={replayer.state === "playing" || replayer.state === "done"} onClick={() => replayer.runToEnd()}>To end</button>
          <label className="flex items-center gap-1">
            Speed
            <select className="rounded border px-2 py-1 dark:bg-slate-800" value={replayer.speed} onChange={(e) => replayer.setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          <span className="tabular-nums text-slate-500">
            {(replayer.time / 1000).toFixed(2)} / {(replayer.duration / 1000).toFixed(2)} s · event {replayer.position} / {replayer.length} · {replayer.state}
            {replayer.skipped ? ` · ${replayer.skipped} skipped` : ""}
          </span>
          <button className="btn btn-ghost" onClick={verify}>Verify replay</button>
          <button className="btn btn-ghost" onClick={() => { replayer.dispose(); replayerRef.current = null; setMode("idle"); setController(makeController(null)); }}>Close replay</button>
        </div>
      )}

      {recording && (
        <p className="mb-2 text-xs text-slate-500">
          {recording.label} · {recording.source === "synthetic" ? "synthetic (not hardware)" : "recorded on a device"} · {recording.events.length} events · {recording.committed?.length ?? 0} strokes · {(recordingDuration(recording) / 1000).toFixed(1)} s · recorded at zoom {recording.events[0]?.zoom.toFixed(2) ?? "–"}, now {zoom.toFixed(2)}
          {mode === "replay" && recording.events.length && recording.events[0].zoom !== zoom ? " (replay is rescaled onto this page)" : ""}
        </p>
      )}
      {check && <pre className="mb-2 whitespace-pre-wrap rounded bg-white p-2 text-xs dark:bg-slate-800">{check}</pre>}
      {errors.length > 0 && (
        <div role="alert" className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      <div className="relative overflow-hidden rounded-lg bg-white shadow dark:bg-slate-50" style={{ width: PAGE_WIDTH * zoom, height: HEIGHT * zoom }}>
        <canvas ref={inkRef} className="pointer-events-none absolute left-0 top-0" style={{ width: PAGE_WIDTH * zoom, height: HEIGHT * zoom }} />
        <div ref={surfaceRef} className="ink-surface absolute inset-0" style={{ cursor: live ? "crosshair" : "default", touchAction: "none" }} {...surface} />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Pen {tool.penColor} · {tool.penSize}px · streamline {pen.streamline} · from the notebook&apos;s saved pen settings. Strokes here are not saved to any notebook.
      </p>
      <canvas ref={liveRef} className="pointer-events-none fixed left-0 top-0 z-30" />
    </main>
  );
}
