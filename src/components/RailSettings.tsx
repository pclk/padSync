"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { DEFAULT_RAIL, canHide, isTool, moveItem, setHidden, type RailAlign, type RailDock, type RailItem, type RailLayout } from "@/lib/rail-layout";
import { Icon, type IconName } from "./Icons";
import { usePrompts } from "@/lib/settings";
import { DEFAULT_PROMPTS, MAX_PROMPTS, PROMPT_ICONS, newPrompt, type ChatPrompt } from "@/lib/prompts";
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
  prompts: { label: "Chat prompts", icon: "message" },
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
  const box = usePopoverBox(anchor, 320);
  const [tab, setTab] = useState<"toolbar" | "prompts">("toolbar");
  const [prompts, setPrompts] = usePrompts();
  // Stays open while you use the rail, so changes can be tried as they are made.
  useDismiss(ref, onClose, "[data-tap-zone]");
  const isDefault = JSON.stringify(layout) === JSON.stringify(DEFAULT_RAIL);
  const circle = layout.style === "circle";
  // The circle's tap panel holds colours, sizes and undo, so only its tools (and the prompt
  // circle) are listed.
  const among = circle ? (i: RailItem) => isTool(i) || i === "prompts" : () => true;
  const rows = layout.order.filter(among);

  return (
    <div ref={ref} role="dialog" aria-label="Toolbar settings" className="card fixed z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden shadow-lift" style={box}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div role="tablist" aria-label="Toolbar settings" className="segmented">
          <button role="tab" aria-selected={tab === "toolbar"} onClick={() => setTab("toolbar")}>
            Toolbar
          </button>
          <button role="tab" aria-selected={tab === "prompts"} onClick={() => setTab("prompts")}>
            Prompts
          </button>
        </div>
        {tab === "toolbar" ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setLayout(DEFAULT_RAIL)} disabled={isDefault}>
            Reset
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setPrompts(DEFAULT_PROMPTS)} disabled={JSON.stringify(prompts) === JSON.stringify(DEFAULT_PROMPTS)}>
            Reset
          </button>
        )}
      </div>
      {tab === "prompts" && <PromptSettings prompts={prompts} setPrompts={setPrompts} shown={!layout.hidden.includes("prompts")} />}
      <div className={`min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-3 ${tab === "toolbar" ? "" : "hidden"}`}>
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

        <p className="mb-1 text-xs font-medium text-slate-700">{circle ? "Tools, in fan order, and the prompt circle" : "Items"}</p>
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

/**
 * The prompt menu's prompts: what each says, whether it sends at once or goes into the chat box to
 * finish, its icon, and their order (the order they fan out in).
 */
function PromptSettings({ prompts, setPrompts, shown }: { prompts: ChatPrompt[]; setPrompts: (p: ChatPrompt[]) => void; shown: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const update = (id: string, patch: Partial<ChatPrompt>) => setPrompts(prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...prompts];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setPrompts(next);
  };
  return (
    <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-3">
      <p className="mb-2 text-[11px] text-slate-500">
        Open the prompt menu from the <Icon name="message" className="inline align-[-2px]" /> button{shown ? "" : " (hidden: show Chat prompts on the Toolbar tab)"} or a gesture set to Prompt menu. Prompts use the chat&rsquo;s context: the current page and any lasso selection.
      </p>
      <ul className="-mx-1 space-y-1">
        {prompts.map((pr, i) => (
          <li key={pr.id} className={`rounded-lg ${editing === pr.id ? "bg-slate-50 ring-1 ring-slate-200" : ""}`}>
            <div className="flex items-center gap-1 px-1">
              <Icon name={pr.icon} className="shrink-0 text-lg text-slate-600" />
              <button className="min-h-11 flex-1 truncate pl-1 text-left text-sm text-slate-800" onClick={() => setEditing(editing === pr.id ? null : pr.id)} aria-expanded={editing === pr.id}>
                {pr.label}
                <span className="ml-1.5 text-[11px] text-slate-400">{pr.send ? "sends" : "to finish"}</span>
              </button>
              <button className="icon-btn h-11 w-10" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${pr.label} up`}>
                <Icon name="arrowUp" />
              </button>
              <button className="icon-btn h-11 w-10" disabled={i === prompts.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${pr.label} down`}>
                <Icon name="arrowDown" />
              </button>
            </div>
            {editing === pr.id && (
              <div className="space-y-2 px-2 pb-2">
                <label className="block">
                  <span className="text-xs font-medium text-slate-700">Name</span>
                  <input className="field mt-0.5 h-10 text-sm" value={pr.label} maxLength={24} onChange={(e) => update(pr.id, { label: e.target.value })} />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-700">Prompt</span>
                  <textarea className="field mt-0.5 min-h-24 text-sm" value={pr.text} onChange={(e) => update(pr.id, { text: e.target.value })} />
                </label>
                <label className="flex min-h-11 items-center justify-between gap-2 text-xs font-medium text-slate-700">
                  <span>
                    Send right away
                    <span className="block font-normal text-slate-500">Off: it goes into the chat box for you to finish.</span>
                  </span>
                  <input type="checkbox" className="switch" checked={pr.send} onChange={(e) => update(pr.id, { send: e.target.checked })} />
                </label>
                <div role="radiogroup" aria-label="Icon" className="flex flex-wrap">
                  {PROMPT_ICONS.map((ic) => (
                    <button key={ic} role="radio" aria-checked={pr.icon === ic} aria-label={ic} onClick={() => update(pr.id, { icon: ic })} className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg ${pr.icon === ic ? "bg-brand-600 text-on-accent" : "text-slate-600 hover:bg-slate-100"}`}>
                      <Icon name={ic} />
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn-ghost btn-sm btn-danger"
                  onClick={() => {
                    setPrompts(prompts.filter((p) => p.id !== pr.id));
                    setEditing(null);
                  }}
                >
                  <Icon name="trash" /> Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        className="btn btn-secondary btn-sm mt-3 w-full justify-center"
        disabled={prompts.length >= MAX_PROMPTS}
        onClick={() => {
          const p = newPrompt();
          setPrompts([...prompts, p]);
          setEditing(p.id);
        }}
      >
        <Icon name="plus" /> Add prompt{prompts.length >= MAX_PROMPTS ? ` (up to ${MAX_PROMPTS})` : ""}
      </button>
    </div>
  );
}
