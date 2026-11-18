"use client";

import { useState } from "react";
import { kb, type Bundle, type BundleFile, type ContextOptions, type ContextScope } from "@/lib/context";
import type { SectionEntity } from "@/lib/types";

// "What to send": scope, per-section picks, content toggles, and the exact preview.

export interface TextSelection {
  start: number;
  end: number;
  text: string;
}

interface Props {
  o: ContextOptions;
  set: (patch: Partial<ContextOptions>) => void;
  sections: SectionEntity[];
  pickedIds: string[];
  setPickedIds: (ids: string[]) => void;
  currentId: string;
  /** Source text of the current section, for picking a text selection. */
  source: string;
  textSel: TextSelection | null;
  setTextSel: (s: TextSelection | null) => void;
  /** Strokes lassoed in the current section. */
  lassoCount: number;
  summary: string;
  /** The chat picks the scope and the code switch itself (src/components/chat). */
  hideScope?: boolean;
  hideCode?: boolean;
}

const SCOPES: [ContextScope, string][] = [
  ["all", "Whole notebook"],
  ["sections", "Sections"],
  ["selection", "Selection"],
];

export function ContextControls(p: Props) {
  const { o, set } = p;
  const toggle = (key: keyof ContextOptions, label: string, title: string, disabled = false) => (
    <label className={`flex items-center gap-1 ${disabled ? "text-slate-300" : "text-slate-600"}`} title={title}>
      <input type="checkbox" disabled={disabled} checked={!!o[key] && !disabled} onChange={(e) => set({ [key]: e.target.checked })} /> {label}
    </label>
  );
  const sel = o.scope === "selection";
  return (
    <div className="space-y-2 text-xs" data-testid="context-controls">
      {!p.hideScope && (
      <div className="flex rounded-lg border border-slate-300 bg-white p-0.5" role="radiogroup" aria-label="What to send">
        {SCOPES.map(([v, label]) => (
          <button
            key={v}
            role="radio"
            aria-checked={o.scope === v}
            className={`flex-1 rounded-md px-2 py-1 ${o.scope === v ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            onClick={() => set({ scope: v })}
          >
            {label}
          </button>
        ))}
      </div>
      )}

      {o.scope === "sections" && (
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <div className="mb-1 flex gap-2 text-blue-700">
            <button onClick={() => p.setPickedIds(p.sections.map((s) => s.id))}>All</button>
            <button onClick={() => p.setPickedIds([])}>None</button>
            <button onClick={() => p.setPickedIds([p.currentId])}>Only this one</button>
            <span className="ml-auto text-slate-400">
              {p.pickedIds.length} / {p.sections.length}
            </span>
          </div>
          <ul className="max-h-40 overflow-y-auto">
            {p.sections.map((s, i) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 py-0.5 text-slate-700">
                  <input
                    type="checkbox"
                    checked={p.pickedIds.includes(s.id)}
                    onChange={(e) => p.setPickedIds(e.target.checked ? [...p.pickedIds, s.id] : p.pickedIds.filter((id) => id !== s.id))}
                  />
                  <span className="w-5 text-right tabular-nums text-slate-400">{i + 1}</span>
                  <span className="truncate">{s.data.title ?? (s.data.blocks.length ? "Untitled" : "Blank page")}</span>
                  {s.id === p.currentId && <span className="ml-auto rounded bg-blue-50 px-1 text-[10px] text-blue-700">here</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sel && (
        <div className="space-y-1 rounded-lg border border-slate-200 bg-white p-2">
          <p className="text-slate-500">Highlight text below, and/or lasso ink on the page (L). Only the selection is sent.</p>
          <textarea
            readOnly
            className="h-24 w-full resize-y rounded border border-slate-200 bg-slate-50 p-1 font-mono text-[11px]"
            value={p.source}
            aria-label="Section text to select from"
            onSelect={(e) => {
              const t = e.currentTarget;
              const text = t.value.slice(t.selectionStart, t.selectionEnd);
              p.setTextSel(text.trim() ? { start: t.selectionStart, end: t.selectionEnd, text } : null);
            }}
          />
          <p className="text-slate-600">
            {p.textSel ? `${p.textSel.text.length} characters highlighted` : "No text highlighted"} ·{" "}
            {p.lassoCount ? `${p.lassoCount} stroke${p.lassoCount === 1 ? "" : "s"} lassoed` : "no ink lassoed"}
            {p.textSel && (
              <button className="ml-2 text-blue-700" onClick={() => p.setTextSel(null)}>
                clear
              </button>
            )}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {toggle("renders", "handwriting", "One image per section with the printed content and your ink.", sel)}
        {toggle("notes", "typed notes", "Text boxes you typed on the page.", sel)}
        {toggle("solutions", "hidden solutions", "The AI sees reference solutions but is told not to reveal them unless you ask.", sel)}
        {toggle("images", "embedded images", "Images inside the printed content, as files.", sel)}
        {toggle("recentOnly", "changed in last 24 h", "Only sections you edited or wrote on in the last day.", sel)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {toggle("allowEdits", "let AI edit a copy", "The AI may write changed copies to an out/ folder; you review them before anything changes here.")}
        {!p.hideCode && toggle("allowCode", "allow running code", "Claude Code also gets Bash, in its sandbox. Codex always runs commands in its own sandbox.", !o.allowEdits)}
      </div>
      <p className="text-slate-500" data-testid="context-summary">
        {p.summary}
      </p>
    </div>
  );
}

export function BundlePreview({ bundle, onClose }: { bundle: Bundle; onClose: () => void }) {
  return (
    <div className="mt-2 rounded-lg border border-slate-300 bg-white p-2 text-xs" data-testid="bundle-preview">
      <div className="mb-1 flex items-center">
        <span className="font-medium text-slate-700">
          Exactly what will be sent: {bundle.files.length} files · {kb(bundle.bytes)} · ~{bundle.tokens.toLocaleString()} tokens
        </span>
        <button className="ml-auto text-slate-500" onClick={onClose} aria-label="Close preview">
          ✕
        </button>
      </div>
      {bundle.error && <p className="text-rose-700">{bundle.error}</p>}
      {bundle.skipped.length > 0 && <p className="mb-1 text-amber-700">Left out: {bundle.skipped.join(", ")}</p>}
      <ul className="space-y-1">
        {bundle.files.map((f) => (
          <PreviewFile key={f.path} f={f} />
        ))}
      </ul>
      <p className="mt-1 text-slate-400">The Mac bridge writes these into a private temp folder for the AI and deletes it afterwards.</p>
    </div>
  );
}

function PreviewFile({ f }: { f: BundleFile }) {
  const [open, setOpen] = useState(f.path === "notebook.md" || f.path === "selection.md");
  const size = f.base64 != null ? (f.base64.length * 3) / 4 : new TextEncoder().encode(f.text ?? "").length;
  return (
    <li>
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="font-mono text-slate-700">{f.path}</span>
        <span className="ml-auto text-slate-400">{kb(size)}</span>
      </button>
      {open &&
        (f.base64 != null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:${f.mime};base64,${f.base64}`} alt={f.path} className="mt-1 max-h-48 border border-slate-200" />
        ) : (
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-1 text-[11px]">{f.text}</pre>
        ))}
    </li>
  );
}
