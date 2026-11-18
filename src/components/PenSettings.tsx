"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ToolState } from "@/ink/controller";
import {
  DEFAULT_PEN,
  PEN_GROUPS,
  penOverrides,
  pressureOf,
  setPressure,
  setSmoothness,
  smoothnessOf,
  withOverrides,
  type Easing,
  type PenParamSpec,
  type PenParams,
} from "@/ink/pen-feel";
import { strokeSvgPath } from "@/ink/render";
import { STROKE_STRIDE, type StrokeData } from "@/lib/types";

const PREVIEW_W = 232;
const PREVIEW_H = 64;

/**
 * A fixed handwriting-like sample (loops, a sharp zigzag, a jittery pressure trace) so the
 * preview shows what the settings do to corners, loops and width.
 */
export function previewPoints(): number[] {
  const pts: number[] = [];
  const add = (x: number, y: number, p: number, t: number) => pts.push(x, y, p, 1.2, 0, t);
  let t = 0;
  // Cursive loops (a prolate trochoid), like a row of joined "l"s.
  for (let i = 0; i <= 120; i++, t += 4) {
    const a = (i / 120) * Math.PI * 6 - Math.PI / 2;
    add(28 + 5 * a - 11 * Math.sin(a), 34 + 18 * Math.cos(a), 0.45 + 0.2 * Math.sin(i * 0.9) * Math.sin(i * 0.23), t);
  }
  // A zigzag with hard corners.
  const zig = [[138, 48], [154, 18], [170, 48], [186, 18], [202, 48], [218, 18]];
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
  /** Viewport y of the pen button's centre; the popover's header lines up with it. */
  anchorY: number;
  onClose: () => void;
}

/**
 * Pen settings, opened by tapping the pen tool again while it is selected: two quick sliders and
 * every pen parameter below them, each adjustable and resettable on its own.
 */
export function PenSettings({ tool, setTool, anchorY, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const params = useMemo(() => withOverrides(tool.pen), [tool.pen]);
  const changed = Object.keys(penOverrides(params)).length;
  const update = (next: PenParams) => setTool({ ...tool, pen: penOverrides(next) });

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
    const data: StrokeData = { tool: "pen", color: tool.penColor, size: tool.penSize, pts: PREVIEW_PTS, t0: 0, input: "pen", device: "", pen: penOverrides(params) };
    return strokeSvgPath(data);
  }, [tool.penColor, tool.penSize, params]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pen settings"
      className="card fixed left-[4.75rem] z-50 max-h-[calc(100dvh-5rem)] w-80 max-w-[calc(100vw-6rem)] overflow-y-auto overscroll-contain p-3 shadow-lift"
      style={{ top: `max(4.25rem, min(${Math.round(anchorY - 28)}px, calc(100dvh - 22rem)))` }}
    >
      <div className="sticky -top-3 z-10 -mx-3 -mt-3 mb-2 bg-[var(--surface,white)] px-3 pb-2 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Pen</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => update(DEFAULT_PEN)} disabled={!changed}>
            Reset all{changed ? ` (${changed})` : ""}
          </button>
        </div>
        <div className="paper overflow-hidden rounded-lg border border-slate-200 bg-white">
          <svg viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} width="100%" aria-label="Preview" role="img">
            <path d={preview} fill={tool.penColor} />
          </svg>
        </div>
      </div>

      <Slider label="Smoothness" low="Precise" high="Smooth" value={smoothnessOf(params)} onChange={(v) => update(setSmoothness(params, v))} />
      <Slider label="Pressure" low="Even" high="Expressive" value={pressureOf(params)} onChange={(v) => update(setPressure(params, v))} />
      <p className="mb-3 text-xs text-slate-500">
        Quick controls set several of the settings below. Settings apply to new strokes; pressure only affects the Apple Pencil.
      </p>

      {PEN_GROUPS.map((g) => (
        <details key={g.title} className="group border-t border-slate-100 py-1">
          <summary className="flex cursor-pointer list-none items-center justify-between py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {g.title}
            <span className="text-slate-400 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
          </summary>
          {g.note && <p className="mb-2 text-[11px] text-slate-500">{g.note}</p>}
          {g.params.map((spec) => (
            <Param key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => update({ ...params, [spec.key]: v })} />
          ))}
        </details>
      ))}
    </div>
  );
}

function Param({ spec, value, onChange }: { spec: PenParamSpec; value: PenParams[keyof PenParams]; onChange: (v: PenParams[keyof PenParams]) => void }) {
  const def = DEFAULT_PEN[spec.key];
  const reset = value !== def && (
    <button className="text-[11px] font-medium text-brand-600 hover:underline" onClick={() => onChange(def)} aria-label={`Reset ${spec.label}`}>
      Reset
    </button>
  );
  if (spec.kind === "toggle") {
    return (
      <div className="mb-2.5">
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-slate-700">
          <span>{spec.label}</span>
          <span className="flex items-center gap-2">
            {reset}
            <input type="checkbox" className="switch" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} aria-label={spec.label} />
          </span>
        </label>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{spec.help}</p>
      </div>
    );
  }
  if (spec.kind === "select") {
    return (
      <div className="mb-2.5">
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-slate-700">
          <span>{spec.label}</span>
          <span className="flex items-center gap-2">
            {reset}
            <select className="field h-8 py-0 text-xs" value={value as string} onChange={(e) => onChange(e.target.value as Easing)} aria-label={spec.label}>
              {spec.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </span>
        </label>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{spec.help}</p>
      </div>
    );
  }
  const n = value as number;
  const set = (v: number) => Number.isFinite(v) && onChange(Math.min(spec.max, Math.max(spec.min, v)));
  return (
    <div className="mb-2.5">
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-700">
        <span>{spec.label}</span>
        <span className="flex items-center gap-2">
          {reset}
          <span className="flex items-center gap-1">
            <input
              type="number"
              className="field h-7 w-16 px-1.5 py-0 text-right text-xs tabular-nums"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={n}
              onChange={(e) => set(Number(e.target.value))}
              aria-label={`${spec.label} value`}
            />
            <span className="w-5 text-[11px] text-slate-400">{spec.unit}</span>
          </span>
        </span>
      </div>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={n} onChange={(e) => set(Number(e.target.value))} className="h-7 w-full" aria-label={spec.label} />
      <p className="text-[11px] leading-snug text-slate-500">{spec.help}</p>
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
