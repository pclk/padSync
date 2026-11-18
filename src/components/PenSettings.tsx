"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Viewport x of the popover's left edge; by default it sits just right of the iPad rail. */
  left?: number;
  onClose: () => void;
}

/**
 * Pen settings, opened by tapping the pen tool again while it is selected: two quick sliders and
 * every pen parameter in tabs, each adjustable and resettable on its own.
 */
export function PenSettings({ tool, setTool, anchorY, left, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const params = useMemo(() => withOverrides(tool.pen), [tool.pen]);
  const overrides = penOverrides(params);
  const changed = Object.keys(overrides).length;
  const update = (next: PenParams) => setTool({ ...tool, pen: penOverrides(next) });
  const [tab, setTab] = useState("Quick");
  const box = usePopoverBox(anchorY);

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

  const tabs = ["Quick", ...PEN_GROUPS.map((g) => g.tab)];

  // A fixed header (title, preview, tabs) over a body that scrolls on its own, sized to the
  // visible screen, so every setting is reachable however short the screen is.
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Pen settings"
      className="card fixed left-[4.75rem] z-50 flex w-80 max-w-[calc(100vw-6rem)] flex-col overflow-hidden shadow-lift"
      style={{ top: box.top, maxHeight: box.maxHeight, ...(left === undefined ? {} : { left }) }}
    >
      <div className="shrink-0 border-b border-slate-100 px-3 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Pen</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => update(DEFAULT_PEN)} disabled={!changed}>
            Reset all{changed ? ` (${changed})` : ""}
          </button>
        </div>
        <div className="paper overflow-hidden rounded-lg border border-slate-200 bg-white">
          <svg viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} width="100%" aria-label="Preview" role="img" className="max-h-20">
            <path d={preview} fill={tool.penColor} />
          </svg>
        </div>
        <div role="tablist" aria-label="Pen setting groups" className="-mx-3 mt-2 flex overflow-x-auto px-2">
          {tabs.map((t) => {
            const group = PEN_GROUPS.find((g) => g.tab === t);
            const dirty = group?.params.some((p) => p.key in overrides);
            return (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`relative shrink-0 border-b-2 px-2 py-2 text-xs font-medium ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              >
                {t}
                {dirty && <span className="absolute right-0.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand-500" aria-label="changed" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 py-3">
        <div role="tabpanel" hidden={tab !== "Quick"}>
          <Slider label="Smoothness" low="Precise" high="Smooth" value={smoothnessOf(params)} onChange={(v) => update(setSmoothness(params, v))} />
          <Slider label="Pressure" low="Even" high="Expressive" value={pressureOf(params)} onChange={(v) => update(setPressure(params, v))} />
          <p className="text-xs text-slate-500">
            These set several settings in the other tabs at once. Settings apply to new strokes; pressure only affects the Apple Pencil.
          </p>
        </div>
        {PEN_GROUPS.map((g) => (
          <div key={g.tab} role="tabpanel" aria-label={g.title} hidden={tab !== g.tab}>
            {g.note && <p className="mb-3 text-[11px] text-slate-500">{g.note}</p>}
            {g.params.map((spec) => (
              <Param key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => update({ ...params, [spec.key]: v })} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Top and height for the popover from the visible screen (visualViewport where there is one, so
 * Safari's bars and the keyboard are accounted for), kept up to date as it changes.
 */
function usePopoverBox(anchorY: number) {
  const measure = () => {
    if (typeof window === "undefined") return { top: 68, maxHeight: 600 };
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const offset = vv?.offsetTop ?? 0;
    const margin = 12;
    // Line the header up with the pen button, but never so low that less than 320 px fit.
    const top = Math.max(offset + 68, Math.min(anchorY - 28, offset + height - 320 - margin));
    return { top, maxHeight: Math.max(200, offset + height - top - margin) };
  };
  const [box, setBox] = useState(measure);
  useEffect(() => {
    const update = () => setBox(measure());
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
    // measure reads anchorY; re-measure when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorY]);
  return box;
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
