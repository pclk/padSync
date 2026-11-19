"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { TOOLBAR_H } from "@/lib/notebook-viewport";
import type { ChatPrompt } from "@/lib/prompts";
import { DRAG_SLOP, HOLD_MS, fanLayout, fanPoint, pickByDirection } from "@/lib/tool-circle";
import { Icon, type IconName } from "./Icons";
import { useDismiss } from "./popover";

// The circle menus' shared parts: items fanned out around a point (the tool circle's tools, the
// prompt menu's prompts), and the press that opens them: hold or start dragging to fan them out,
// move towards one and let go to pick it.

export interface FanItem {
  key: string;
  label: string;
  icon: IconName;
  /** Marked as the one in use (the current tool). */
  current?: boolean;
  /** Shown as a swatch of this colour instead of the icon (the lasso's colour fan). */
  color?: string;
}

export interface FanState {
  items: FanItem[];
  angles: number[];
  radius: number;
  center: [number, number];
  viewport: [number, number];
  /** The item the finger points at, or -1. */
  hot: number;
  /** Open to be tapped (held and let go without pointing, or opened by a tap or gesture). */
  sticky: boolean;
}

export const promptItems = (prompts: ChatPrompt[]): FanItem[] => prompts.map((p) => ({ key: p.id, label: p.label, icon: p.icon }));

export function fanAt(items: FanItem[], center: [number, number], sticky = false): FanState {
  const viewport: [number, number] = [window.innerWidth, window.innerHeight];
  const { angles, radius } = fanLayout(items.length, center, viewport, TOOLBAR_H);
  return { items, angles, radius, center, viewport, hot: -1, sticky };
}

/** Which item a finger `dx, dy` from where it pressed points at. */
export const pointAt = (fan: FanState, dx: number, dy: number): FanState => {
  const hot = pickByDirection(fan.angles, dx, dy);
  return hot === fan.hot ? fan : { ...fan, hot };
};

/**
 * A press that opens a fan: held still for HOLD_MS, or dragged past DRAG_SLOP. Moving then points
 * at an item and letting go picks it; letting go without moving leaves the fan open to be tapped;
 * letting go pointing back at the edge closes it. A quick tap calls `onTap`.
 */
export function useFanPress(o: { open: () => FanState | null; onPick: (item: FanItem) => void; onTap: () => void }) {
  const [fan, setFanState] = useState<FanState | null>(null);
  // Pointer handlers read the fan before React has re-rendered it.
  const fanRef = useRef<FanState | null>(null);
  const setFan = useCallback((f: FanState | null) => {
    fanRef.current = f;
    setFanState(f);
  }, []);
  const close = useCallback(() => setFan(null), [setFan]);
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; wasOpen: boolean } | null>(null);
  const opts = useRef(o);
  useEffect(() => {
    opts.current = o;
  });

  const openNow = () => {
    if (fanRef.current) return;
    const f = opts.current.open();
    if (f) setFan(f);
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => endPress, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (press.current) return;
    const wasOpen = fanRef.current !== null;
    setFan(null);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(openNow, HOLD_MS), wasOpen };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!fanRef.current && Math.hypot(dx, dy) > DRAG_SLOP) {
      clearTimeout(d.timer);
      openNow();
    }
    const f = fanRef.current;
    if (f) {
      const next = pointAt(f, dx, dy);
      if (next !== f) setFan(next);
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return;
    endPress();
    const f = fanRef.current;
    // A tap while the fan was open just closes it.
    if (!f) return d.wasOpen ? undefined : opts.current.onTap();
    if (f.hot >= 0) {
      opts.current.onPick(f.items[f.hot]);
      setFan(null);
    } else if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= DRAG_SLOP) setFan({ ...f, sticky: true });
    else setFan(null);
  };
  const onPointerCancel = () => {
    endPress();
    if (!fanRef.current?.sticky) setFan(null);
  };
  return { fan, setFan, close, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}

/**
 * The fanned-out items. While a finger points it only shows; once sticky its items can be tapped.
 * Portalled to the body: a toolbar's backdrop blur would otherwise be what `fixed` is relative to.
 */
export function RadialFan({ fan, label, onPick, onClose }: { fan: FanState; label: string; onPick: (item: FanItem) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, fan.sticky ? onClose : noop, "[data-tap-zone]");
  useEffect(() => {
    if (!fan.sticky) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fan.sticky, onClose]);
  const [cx, cy] = fan.center;
  const halo = fan.radius + 40;
  return createPortal(
    <div ref={ref} className="pointer-events-none fixed inset-0 z-50" role="menu" aria-label={label}>
      <span aria-hidden="true" className="absolute rounded-full bg-slate-900/5" style={{ left: cx - halo, top: cy - halo, width: 2 * halo, height: 2 * halo }} />
      {fan.items.map((item, i) => {
        const [x, y] = fanPoint(fan.angles[i], fan.center, fan.viewport, 30, fan.radius);
        // Labels sit further out along the same direction, so neighbouring ones spread apart.
        const [lx, ly] = fanPoint(fan.angles[i], fan.center, fan.viewport, 56, fan.radius + 44);
        const hot = i === fan.hot;
        return (
          <div key={item.key}>
            <button
              role="menuitem"
              aria-label={item.label}
              tabIndex={fan.sticky ? 0 : -1}
              onClick={() => onPick(item)}
              className={`absolute flex h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-xl shadow-lift transition-transform duration-100 ${fan.sticky ? "pointer-events-auto" : ""} ${hot ? "scale-115 bg-brand-600 text-on-accent" : item.current ? "bg-white text-brand-700 ring-2 ring-brand-500" : "bg-white text-slate-600"}`}
              style={{ left: x, top: y }}
            >
              {item.color ? <span className="h-7 w-7 rounded-full ring-1 ring-black/10" style={{ background: item.color }} /> : <Icon name={item.icon} />}
            </button>
            <span
              aria-hidden="true"
              className={`absolute max-w-32 -translate-x-1/2 -translate-y-1/2 truncate whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium shadow-sm ${fan.sticky ? "pointer-events-auto" : ""} ${hot ? "bg-brand-600 text-on-accent" : "bg-white/95 text-slate-700"}`}
              style={{ left: lx, top: ly }}
              onClick={() => onPick(item)}
            >
              {item.label}
            </span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
const noop = () => {};
