"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ToolKind, ToolState } from "@/ink/controller";
import { SyncBadge } from "./SyncBadge";
import { Icon, type IconName } from "./Icons";
import { PenSettings } from "./PenSettings";

const PEN_COLORS = ["#111827", "#1d4ed8", "#dc2626", "#047857", "#7c3aed"];
const HL_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"];
const PEN_SIZES = [2.2, 3.4, 5.5];
const HL_SIZES = [14, 22, 32];
const ERASER_SIZES = [12, 24, 48];
const COLOR_SLOTS = Math.max(PEN_COLORS.length, HL_COLORS.length);

const TOOLS: { kind: ToolKind; label: string; icon: IconName; key: string }[] = [
  { kind: "pen", label: "Pen", icon: "pen", key: "P" },
  { kind: "highlighter", label: "Highlighter", icon: "highlighter", key: "H" },
  { kind: "eraser", label: "Eraser", icon: "eraser", key: "E" },
  { kind: "lasso", label: "Lasso", icon: "lasso", key: "L" },
  { kind: "text", label: "Text", icon: "text", key: "T" },
];

interface Props {
  layout?: { mode: "auto" | "drawing" | "chat"; effective: "drawing" | "chat"; setMode: (mode: "auto" | "drawing" | "chat") => void };
  notebookId?: string;
  title: string;
  tool: ToolState;
  setTool: (t: ToolState) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  onZoomReset: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function Toolbar(p: Props) {
  const { tool, setTool } = p;
  const colors = tool.kind === "highlighter" ? HL_COLORS : PEN_COLORS;
  const color = tool.kind === "highlighter" ? tool.hlColor : tool.penColor;
  const sizes = tool.kind === "highlighter" ? HL_SIZES : tool.kind === "eraser" ? ERASER_SIZES : PEN_SIZES;
  const size = tool.kind === "highlighter" ? tool.hlSize : tool.kind === "eraser" ? tool.eraserSize : tool.penSize;
  // Tapping the pen again while it is selected opens its settings (smoothness, pressure).
  const [penMenuY, setPenMenuY] = useState<number | null>(null);
  const closePenMenu = useCallback(() => setPenMenuY(null), []);
  const penMenuOpen = penMenuY !== null && tool.kind === "pen";
  const showColors = tool.kind === "pen" || tool.kind === "highlighter";
  const showSizes = showColors || tool.kind === "eraser";

  const setColor = (c: string) => setTool(tool.kind === "highlighter" ? { ...tool, hlColor: c } : { ...tool, penColor: c });
  const setSize = (s: number) =>
    setTool(tool.kind === "highlighter" ? { ...tool, hlSize: s } : tool.kind === "eraser" ? { ...tool, eraserSize: s } : { ...tool, penSize: s });

  // The top bar keeps navigation and status; the drawing tools sit in a rail on the left edge,
  // within thumb reach while the other hand holds the Pencil.
  return (
    <>
      <header className="toolbar fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-1.5 border-b border-slate-200/80 bg-white/90 px-2 backdrop-blur-md sm:gap-2 sm:px-3">
        <Link href="/" className="btn btn-ghost px-2" aria-label="Library">
          <Icon name="back" className="text-lg" /><span className="hidden sm:inline">Library</span>
        </Link>
        <span aria-hidden="true" className="h-5 w-px bg-slate-200" />
        <div className="mr-auto min-w-0 max-w-[40ch] truncate px-1 text-sm font-semibold text-slate-900">{p.title}</div>

        <button className="btn btn-ghost btn-sm tabular-nums text-slate-500" onClick={p.onZoomReset} title="Reset zoom">
          {Math.round(p.zoom * 100)}%
        </button>
        {p.notebookId && <Link href={`/import?notebookId=${encodeURIComponent(p.notebookId)}`} className="btn btn-ghost btn-sm"><Icon name="sparkles" className="text-brand-600" /><span className="hidden md:inline">AI & PDFs</span></Link>}
        {p.layout && <div role="group" aria-label="Layout" className="segmented hidden sm:inline-flex">
          {(["auto", "drawing", "chat"] as const).map(mode => <button key={mode} aria-pressed={p.layout!.mode === mode} onClick={() => p.layout!.setMode(mode)}>{mode === "auto" ? "Auto" : mode === "drawing" ? "Drawing" : "Chat"}{mode === "auto" && p.layout!.mode === "auto" && <span aria-label={p.layout!.effective} title={p.layout!.effective} className={`inline-block h-1.5 w-1.5 rounded-full ${p.layout!.effective === "drawing" ? "bg-brand-500" : "bg-emerald-500"}`} />}</button>)}
        </div>}
        <SyncBadge />
        <button
          className="btn btn-ghost px-2.5"
          aria-pressed={p.panelOpen}
          onClick={p.onTogglePanel}
          title="Toggle side panel"
        >
          <Icon name="panel" className="text-lg" /><span className="hidden lg:inline">Panel</span>
        </button>
      </header>

      <aside className="tool-rail fixed left-3 top-1/2 z-40 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col items-center gap-2 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/90 p-1.5 shadow-lift backdrop-blur-md">
        <div className="flex flex-col gap-0.5">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              title={t.kind === "pen" ? `${t.label} (${t.key}) — tap again for settings` : `${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool.kind === t.kind}
              {...(t.kind === "pen" ? { "data-pen-tool": "", "aria-haspopup": "dialog" as const, "aria-expanded": penMenuOpen } : {})}
              onClick={(e) => {
                if (t.kind === "pen" && tool.kind === "pen") {
                  const r = e.currentTarget.getBoundingClientRect();
                  setPenMenuY(penMenuOpen ? null : r.top + r.height / 2);
                  return;
                }
                setPenMenuY(null);
                setTool({ ...tool, kind: t.kind });
              }}
              className={`flex h-11 w-11 items-center justify-center rounded-xl text-xl transition-colors ${tool.kind === t.kind ? "bg-brand-600 text-on-accent shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>

        {/* Colour and size slots are always laid out (hidden when the tool has none) so the rail
            keeps one height and nothing moves under your finger when you switch tools. */}
        <div className={`flex flex-col items-center gap-2 border-t border-slate-100 pt-2 ${showColors ? "" : "invisible"}`} aria-hidden={!showColors}>
          {Array.from({ length: COLOR_SLOTS }, (_, i) => {
            const c = colors[i];
            if (!c) return <span key={`empty${i}`} className="h-7 w-7" />;
            return (
              <button
                key={c}
                onClick={() => setColor(c)}
                tabIndex={showColors ? 0 : -1}
                className={`h-7 w-7 rounded-full ring-offset-2 transition-shadow ${color === c ? "ring-2 ring-slate-400" : "ring-1 ring-black/10"}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            );
          })}
        </div>
        <div className={`flex flex-col items-center gap-1 ${showSizes ? "" : "invisible"}`} aria-hidden={!showSizes}>
          {sizes.map((s, i) => (
            <button
              key={i}
              onClick={() => setSize(s)}
              tabIndex={showSizes ? 0 : -1}
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${size === s ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
              aria-label={`Size ${i + 1}`}
            >
              <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
            </button>
          ))}
        </div>

        <div className="flex flex-col border-t border-slate-100 pt-1">
          <button className="icon-btn h-10 w-11 text-lg" disabled={!p.canUndo} onClick={p.onUndo} title="Undo (two-finger tap, ⌘Z)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button className="icon-btn h-10 w-11 text-lg" disabled={!p.canRedo} onClick={p.onRedo} title="Redo (three-finger tap, ⇧⌘Z)" aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
      </aside>
      {penMenuOpen && <PenSettings tool={tool} setTool={setTool} anchorY={penMenuY} onClose={closePenMenu} />}
    </>
  );
}
