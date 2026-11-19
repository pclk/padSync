"use client";

import Link from "next/link";
import { useRef } from "react";
import { DEFAULT_RAIL, canHide, isTool, moveItem, setHidden, type RailAlign, type RailDock, type RailItem, type RailLayout } from "@/lib/rail-layout";
import { Icon, type IconName } from "./Icons";
import { useDismiss, usePopoverBox, type PopoverAnchor } from "./popover";

export const RAIL_ITEM_INFO: Record<RailItem, { label: string; icon?: IconName }> = {
  pen: { label: "Pen", icon: "pen" },
  highlighter: { label: "Highlighter", icon: "highlighter" },
  eraser: { label: "Eraser", icon: "eraser" },
  lasso: { label: "Lasso", icon: "lasso" },
  text: { label: "Text", icon: "text" },
  colors: { label: "Colours" },
  sizes: { label: "Sizes" },
  history: { label: "Undo & redo", icon: "undo" },
};

const DOCK_LABELS: Record<RailDock, string> = { left: "Left", right: "Right", bottom: "Bottom" };
const ALIGN_LABELS: Record<RailDock, Record<RailAlign, string>> = {
  left: { start: "Top", center: "Middle", end: "Bottom" },
  right: { start: "Top", center: "Middle", end: "Bottom" },
  bottom: { start: "Left", center: "Centre", end: "Right" },
};

interface Props {
  layout: RailLayout;
  setLayout: (l: RailLayout) => void;
  anchor: PopoverAnchor;
  onClose: () => void;
}

/**
 * The rail's own settings, from the gear at its end: where it docks, and which items it shows in
 * what order. Rows move with arrow buttons rather than dragging, so a finger can't miss.
 */
export function RailSettings({ layout, setLayout, anchor, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const box = usePopoverBox(anchor, 288);
  // Stays open while you use the rail, so changes can be tried as they are made.
  useDismiss(ref, onClose, "[data-tap-zone]");
  const isDefault = JSON.stringify(layout) === JSON.stringify(DEFAULT_RAIL);
  const circle = layout.style === "circle";
  // The circle's tap panel holds colours, sizes and undo, so only its tools are listed.
  const among = circle ? isTool : () => true;
  const rows = layout.order.filter(among);

  return (
    <div ref={ref} role="dialog" aria-label="Toolbar settings" className="card fixed z-50 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden shadow-lift" style={box}>
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-900">Toolbar</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setLayout(DEFAULT_RAIL)} disabled={isDefault}>
          Reset
        </button>
      </div>
      <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-3">
        <p className="mb-1 text-xs font-medium text-slate-700">Style</p>
        <div role="group" aria-label="Style" className="segmented mb-1 flex w-full [&>button]:flex-1">
          {(["bar", "circle"] as const).map((st) => (
            <button key={st} aria-pressed={layout.style === st} onClick={() => setLayout({ ...layout, style: st })}>
              {st === "bar" ? "Bar" : "Circle"}
            </button>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-slate-500">
          {circle ? "Hold the circle and drag towards a tool to pick it; tap it for colours and sizes." : "Every tool, colour and size as a button."}
        </p>
        <p className="mb-1 text-xs font-medium text-slate-700">Position</p>
        <div role="group" aria-label="Position" className="segmented mb-2 flex w-full [&>button]:flex-1">
          {(Object.keys(DOCK_LABELS) as RailDock[]).map((d) => (
            <button key={d} aria-pressed={layout.dock === d} onClick={() => setLayout({ ...layout, dock: d })}>
              {DOCK_LABELS[d]}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Alignment" className="segmented mb-4 flex w-full [&>button]:flex-1">
          {(["start", "center", "end"] as const).map((a) => (
            <button key={a} aria-pressed={layout.align === a} onClick={() => setLayout({ ...layout, align: a })}>
              {ALIGN_LABELS[layout.dock][a]}
            </button>
          ))}
        </div>

        <p className="mb-1 text-xs font-medium text-slate-700">{circle ? "Tools, in fan order" : "Items"}</p>
        <ul className="-mx-1">
          {rows.map((item, i) => {
            const { label, icon } = RAIL_ITEM_INFO[item];
            const shown = !layout.hidden.includes(item);
            return (
              <li key={item} className="flex items-center gap-1 rounded-lg px-1">
                <span className={`flex w-5 shrink-0 items-center justify-center text-lg ${shown ? "text-slate-600" : "opacity-40"}`}>
                  {icon ? <Icon name={icon} /> : item === "colors" ? <span className="h-4 w-4 rounded-full" style={{ background: "conic-gradient(#dc2626, #facc15, #047857, #1d4ed8, #7c3aed, #dc2626)" }} /> : <span className="flex items-center gap-0.5">{[3, 5, 7].map((d) => <span key={d} className="rounded-full bg-slate-500" style={{ width: d, height: d }} />)}</span>}
                </span>
                <span className={`flex-1 truncate pl-1 text-sm ${shown ? "text-slate-800" : "text-slate-400"}`}>{label}</span>
                <button className="icon-btn h-11 w-10" disabled={i === 0} onClick={() => setLayout(moveItem(layout, item, -1, among))} aria-label={`Move ${label} up`}>
                  <Icon name="arrowUp" />
                </button>
                <button className="icon-btn h-11 w-10" disabled={i === rows.length - 1} onClick={() => setLayout(moveItem(layout, item, 1, among))} aria-label={`Move ${label} down`}>
                  <Icon name="arrowDown" />
                </button>
                <label className="flex h-11 w-12 items-center justify-center" title={canHide(item) ? undefined : "The pen is always shown"}>
                  <input type="checkbox" className="switch" checked={shown} disabled={!canHide(item)} onChange={(e) => setLayout(setHidden(layout, item, !e.target.checked))} aria-label={`Show ${label}`} />
                </label>
              </li>
            );
          })}
        </ul>
        <Link href="/settings#gestures" className="btn btn-secondary btn-sm mt-3 w-full justify-center">
          Touch gestures…
        </Link>
        <p className="mt-2 text-[11px] text-slate-500">
          Hidden tools still work from the keyboard. {circle ? "Presses just outside the circle still count." : "Taps near a button, or between buttons, go to the closest one."}
        </p>
      </div>
    </div>
  );
}
