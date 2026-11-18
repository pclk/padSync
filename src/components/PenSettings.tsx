"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ToolState } from "@/ink/controller";
import { DEFAULT_SENSITIVITY, DEFAULT_SMOOTHING } from "@/ink/pen-feel";
import { strokeSvgPath } from "@/ink/render";
import { STROKE_STRIDE, type StrokeData } from "@/lib/types";

const PREVIEW_W = 232;
const PREVIEW_H = 64;

/**
 * A fixed handwriting-like sample (loops, a sharp zigzag, a jittery pressure trace) so the
 * preview shows both what smoothing does to corners and what sensitivity does to width.
 */
export function previewPoints(): number[] {
  const pts: number[] = [];
  const add = (x: number, y: number, p: number, t: number) => pts.push(x, y, p, 1.2, 0, t);
  let t = 0;
  // Three cursive loops.
  for (let i = 0; i <= 90; i++, t += 4) {
    const a = (i / 90) * Math.PI * 6;
    add(14 + i * 1.25 + 9 * Math.sin(a), 36 - 16 * Math.abs(Math.sin(a / 2)) + 4 * Math.cos(a), 0.45 + 0.25 * Math.sin(i * 0.9) * Math.sin(i * 0.23), t);
  }
  // A zigzag with hard corners.
  const zig = [[128, 46], [146, 18], [164, 46], [182, 18], [200, 46], [218, 18]];
  for (let k = 1; k < zig.length; k++) {
    const [x0, y0] = zig[k - 1];
    const [x1, y1] = zig[k];
    for (let j = 1; j <= 8; j++, t += 4) add(x0 + ((x1 - x0) * j) / 8, y0 + ((y1 - y0) * j) / 8, 0.5 + 0.2 * Math.sin(t * 0.7), t);
  }
  return pts.map((v, i) => (i % STROKE_STRIDE === 5 ? v : Math.round(v * 100) / 100));
}

const PREVIEW_PTS = previewPoints();

interface Props {
  tool: ToolState;
  setTool: (t: ToolState) => void;
  /** Viewport y of the pen button's centre, so the popover sits beside it. */
  anchorY: number;
  onClose: () => void;
}

/** Pen feel: opened by tapping the pen tool again while it is selected. */
export function PenSettings({ tool, setTool, anchorY, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const smoothing = tool.penSmoothing ?? DEFAULT_SMOOTHING;
  const sensitivity = tool.penSensitivity ?? DEFAULT_SENSITIVITY;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Close on a press outside, but not on the rail's pen button (it toggles us itself).
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.("[data-pen-tool]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const preview = useMemo(() => {
    const data: StrokeData = { tool: "pen", color: tool.penColor, size: tool.penSize, pts: PREVIEW_PTS, t0: 0, input: "pen", device: "", smoothing, sensitivity };
    return strokeSvgPath(data);
  }, [tool.penColor, tool.penSize, smoothing, sensitivity]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pen settings"
      className="card fixed left-[4.75rem] z-50 w-64 -translate-y-1/2 p-3 shadow-lift"
      style={{ top: `clamp(9rem, ${anchorY}px, calc(100dvh - 9rem))` }}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Pen</h2>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setTool({ ...tool, penSmoothing: DEFAULT_SMOOTHING, penSensitivity: DEFAULT_SENSITIVITY })}
          disabled={smoothing === DEFAULT_SMOOTHING && sensitivity === DEFAULT_SENSITIVITY}
        >
          Reset
        </button>
      </div>
      <div className="paper mb-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <svg viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} width="100%" aria-label="Preview" role="img">
          <path d={preview} fill={tool.penColor} />
        </svg>
      </div>
      <Slider label="Smoothness" low="Precise" high="Smooth" value={smoothing} onChange={(v) => setTool({ ...tool, penSmoothing: v })} />
      <Slider label="Pressure" low="Even" high="Expressive" value={sensitivity} onChange={(v) => setTool({ ...tool, penSensitivity: v })} />
      <p className="mt-2 text-xs text-slate-500">Applies to new strokes. Pressure only affects the Apple Pencil.</p>
    </div>
  );
}

function Slider(p: { label: string; low: string; high: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="mb-2 block">
      <span className="flex items-baseline justify-between text-xs font-medium text-slate-700">
        {p.label}
        <span className="tabular-nums text-slate-500">{Math.round(p.value * 100)}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={p.value}
        onChange={(e) => p.onChange(Number(e.target.value))}
        className="mt-1 h-8 w-full"
        aria-label={p.label}
      />
      <span className="flex justify-between text-[11px] text-slate-400">
        <span>{p.low}</span>
        <span>{p.high}</span>
      </span>
    </label>
  );
}
