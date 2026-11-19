"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ToolKind, ToolState } from "@/ink/controller";
import { visibleTools, type RailLayout } from "@/lib/rail-layout";
import { DRAG_SLOP, FAN_RADIUS, HOLD_MS, fanAngles, fanPoint, pickByDirection } from "@/lib/tool-circle";
import { Icon } from "./Icons";
import { anchorOf, useDismiss, usePopoverBox, type PopoverAnchor } from "./popover";
import { dockStrip, tapZonePadding } from "./rail-dock";
import { RAIL_ITEM_INFO } from "./RailSettings";

interface Props {
  tool: ToolState;
  colors: string[];
  color: string;
  sizes: number[];
  size: number;
  showColors: boolean;
  showSizes: boolean;
  setColor: (c: string) => void;
  setSize: (s: number) => void;
  selectTool: (kind: ToolKind) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  rail: RailLayout;
  rightInset: number;
  /** Open the pen's or the toolbar's settings beside the circle. */
  onPenSettings: (circle: HTMLElement) => void;
  onSettings: (circle: HTMLElement) => void;
}

interface Fan {
  tools: ToolKind[];
  angles: number[];
  center: [number, number];
  viewport: [number, number];
  /** The tool the finger points at, or -1. */
  hot: number;
  /** Held and let go without pointing anywhere: the fan stays open to be tapped. */
  sticky: boolean;
}

/**
 * The iPad's circle toolbar. Press and hold the circle (or start dragging) and the tools fan out
 * around it; move towards one and let go to pick it. Let go without pointing and the fan stays
 * open to be tapped; point back at the edge and nothing changes. A quick tap opens the current
 * tool's colours and sizes. The whole tap zone around the circle counts as the circle.
 */
export function ToolCircle(p: Props) {
  const circleRef = useRef<HTMLElement>(null);
  const [fan, setFanState] = useState<Fan | null>(null);
  // Pointer handlers read the fan before React has re-rendered it.
  const fanRef = useRef<Fan | null>(null);
  const setFan = (f: Fan | null) => {
    fanRef.current = f;
    setFanState(f);
  };
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [panel, setPanel] = useState<PopoverAnchor | null>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  const closeFan = useCallback(() => {
    fanRef.current = null;
    setFanState(null);
  }, []);
  const label = RAIL_ITEM_INFO[p.tool.kind].label;

  const openFan = () => {
    const el = circleRef.current;
    if (!el || fanRef.current) return;
    const r = el.getBoundingClientRect();
    const center: [number, number] = [r.left + r.width / 2, r.top + r.height / 2];
    const viewport: [number, number] = [window.innerWidth, window.innerHeight];
    const tools = visibleTools(p.rail);
    setPanel(null);
    setFan({ tools, angles: fanAngles(tools.length, center, viewport), center, viewport, hot: -1, sticky: false });
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => endPress, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (press.current) return;
    closeFan();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(openFan, HOLD_MS) };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!fanRef.current && Math.hypot(dx, dy) > DRAG_SLOP) {
      clearTimeout(d.timer);
      openFan();
    }
    const f = fanRef.current;
    if (!f) return;
    const hot = pickByDirection(f.angles, dx, dy);
    if (hot !== f.hot) setFan({ ...f, hot });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return;
    endPress();
    const f = fanRef.current;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_SLOP;
    if (!f) {
      // A quick tap: the current tool's colours and sizes.
      const el = circleRef.current;
      if (el) setPanel(panel ? null : anchorOf(el, p.rail.dock));
      return;
    }
    if (f.hot >= 0) {
      p.selectTool(f.tools[f.hot]);
      closeFan();
    } else if (!moved) setFan({ ...f, sticky: true });
    else closeFan();
  };
  const onPointerCancel = () => {
    endPress();
    if (!fanRef.current?.sticky) closeFan();
  };

  const strip = dockStrip(p.rail, p.rightInset);
  return (
    <>
      <div className={strip.className} style={strip.style} data-dock={p.rail.dock} data-style="circle">
        <div
          data-tap-zone=""
          className={`pointer-events-auto touch-none select-none ${tapZonePadding(p.rail)}`}
          style={{ WebkitTouchCallout: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <aside ref={circleRef} data-rail-settings="" aria-label="Drawing tools" className="tool-circle rounded-full">
            {/* Pointer taps are handled above; a click with no pointer detail is the keyboard. */}
            <button
              className="relative flex h-[60px] w-[60px] items-center justify-center rounded-full border border-slate-200/80 bg-white/90 text-2xl text-slate-800 shadow-lift backdrop-blur-md"
              aria-label={`${label}: hold and drag to change tool, tap for colours and sizes`}
              aria-haspopup="dialog"
              aria-expanded={panel !== null}
              onClick={(e) => {
                if (e.detail === 0 && circleRef.current) setPanel(panel ? null : anchorOf(circleRef.current, p.rail.dock));
              }}
            >
              <Icon name={RAIL_ITEM_INFO[p.tool.kind].icon!} />
              {p.showColors && <span className="absolute bottom-1.5 right-1.5 h-3 w-3 rounded-full ring-2 ring-white" style={{ background: p.color }} />}
            </button>
          </aside>
        </div>
      </div>
      {fan && <ToolFan fan={fan} current={p.tool.kind} onPick={(k) => { p.selectTool(k); closeFan(); }} onClose={closeFan} />}
      {panel && (
        <CirclePanel
          {...p}
          label={label}
          anchor={panel}
          onClose={closePanel}
          onPenSettings={() => {
            setPanel(null);
            if (circleRef.current) p.onPenSettings(circleRef.current);
          }}
          onSettings={() => {
            setPanel(null);
            if (circleRef.current) p.onSettings(circleRef.current);
          }}
        />
      )}
    </>
  );
}

/** The fanned-out tools. While dragging it only shows; once sticky its tools can be tapped. */
function ToolFan({ fan, current, onPick, onClose }: { fan: Fan; current: ToolKind; onPick: (k: ToolKind) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, fan.sticky ? onClose : noop, "[data-tap-zone]");
  const [cx, cy] = fan.center;
  return (
    <div ref={ref} className="pointer-events-none fixed inset-0 z-50" role="menu" aria-label="Tools">
      <span
        aria-hidden="true"
        className="absolute rounded-full bg-slate-900/5"
        style={{ left: cx - FAN_RADIUS - 40, top: cy - FAN_RADIUS - 40, width: 2 * (FAN_RADIUS + 40), height: 2 * (FAN_RADIUS + 40) }}
      />
      {fan.tools.map((k, i) => {
        const [x, y] = fanPoint(fan.angles[i], fan.center, fan.viewport);
        const hot = i === fan.hot;
        const { label, icon } = RAIL_ITEM_INFO[k];
        return (
          <div key={k} className="absolute flex flex-col items-center" style={{ left: x, top: y, transform: "translate(-50%, -50%)" }}>
            <button
              role="menuitem"
              aria-label={label}
              tabIndex={fan.sticky ? 0 : -1}
              onClick={() => onPick(k)}
              className={`flex h-[52px] w-[52px] items-center justify-center rounded-full text-xl shadow-lift transition-transform duration-100 ${fan.sticky ? "pointer-events-auto" : ""} ${hot ? "scale-115 bg-brand-600 text-on-accent" : k === current ? "bg-white text-brand-700 ring-2 ring-brand-500" : "bg-white text-slate-600"}`}
            >
              <Icon name={icon!} />
            </button>
            <span className={`mt-1 rounded-full px-1.5 text-[11px] font-medium ${hot ? "bg-brand-600 text-on-accent" : "bg-white/90 text-slate-600"}`}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
const noop = () => {};

/** The current tool's colours and sizes, from a tap on the circle, with undo, redo and settings. */
function CirclePanel(p: Props & { label: string; anchor: PopoverAnchor; onClose: () => void; onPenSettings: () => void; onSettings: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = usePopoverBox(p.anchor, 256);
  // The circle toggles the panel itself.
  useDismiss(ref, p.onClose, "[data-tap-zone]");
  return (
    <div ref={ref} role="dialog" aria-label={`${p.label} options`} className="card fixed z-50 flex w-64 flex-col overflow-y-auto shadow-lift" style={box}>
      <div className="flex items-center justify-between border-b border-slate-100 py-1.5 pl-3 pr-1.5">
        <h2 className="text-sm font-semibold text-slate-900">{p.label}</h2>
        {p.tool.kind === "pen" && (
          <button className="btn btn-ghost btn-sm" onClick={p.onPenSettings} data-pen-tool="">
            Pen settings
          </button>
        )}
      </div>
      <div className="p-2">
        {p.showColors && (
          <div className="flex flex-wrap" role="group" aria-label="Colours">
            {p.colors.map((c) => (
              <button key={c} onClick={() => p.setColor(c)} className="flex h-11 w-11 items-center justify-center" aria-label={`Color ${c}`} aria-pressed={p.color === c}>
                <span className={`h-8 w-8 rounded-full ring-offset-2 transition-shadow ${p.color === c ? "ring-2 ring-slate-400" : "ring-1 ring-black/10"}`} style={{ background: c }} />
              </button>
            ))}
          </div>
        )}
        {p.showSizes && (
          <div className="flex gap-1" role="group" aria-label="Sizes">
            {p.sizes.map((s, i) => (
              <button
                key={i}
                onClick={() => p.setSize(s)}
                className={`flex h-11 w-11 items-center justify-center rounded-lg ${p.size === s ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
                aria-label={`Size ${i + 1}`}
                aria-pressed={p.size === s}
              >
                <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
              </button>
            ))}
          </div>
        )}
        {!p.showColors && !p.showSizes && <p className="px-1 py-2 text-xs text-slate-500">The {p.label.toLowerCase()} has no colours or sizes.</p>}
      </div>
      <div className="flex items-center border-t border-slate-100 p-1">
        <button className="icon-btn h-11 w-11 text-lg" disabled={!p.canUndo} onClick={p.onUndo} aria-label="Undo" title="Undo (two-finger tap)">
          <Icon name="undo" />
        </button>
        <button className="icon-btn h-11 w-11 text-lg" disabled={!p.canRedo} onClick={p.onRedo} aria-label="Redo" title="Redo (three-finger tap)">
          <Icon name="redo" />
        </button>
        <span className="flex-1" />
        <button className="icon-btn h-11 w-11 text-lg" onClick={p.onSettings} aria-label="Toolbar settings" title="Toolbar settings">
          <Icon name="settings" />
        </button>
      </div>
    </div>
  );
}
