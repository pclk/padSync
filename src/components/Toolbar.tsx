"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { ToolKind, ToolState } from "@/ink/controller";
import { SyncBadge } from "./SyncBadge";
import { Icon, type IconName } from "./Icons";
import { PenSettings } from "./PenSettings";
import { SIDEBAR_W, type ToolbarVariant } from "@/lib/notebook-viewport";

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
  /** "rail" floats over the page (iPad); "sidebar" docks at the left edge (Mac). */
  variant?: ToolbarVariant;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
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
  const pick = (kind: ToolKind, button: HTMLElement) => {
    if (kind === "pen" && tool.kind === "pen") {
      const r = button.getBoundingClientRect();
      setPenMenuY(penMenuOpen ? null : r.top + r.height / 2);
      return;
    }
    setPenMenuY(null);
    setTool({ ...tool, kind });
  };
  const tools: ToolControls = { tool, colors, color, sizes, size, showColors, showSizes, penMenuOpen, pick, setColor, setSize };

  // The top bar keeps navigation and status; the drawing tools sit at the left edge: a floating
  // rail on the iPad, within thumb reach while the other hand holds the Pencil, and a docked
  // sidebar on the Mac that collapses to an icon strip.
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

      {p.variant === "sidebar" ? (
        <ToolSidebar {...tools} open={p.sidebarOpen ?? true} onToggle={p.onToggleSidebar} canUndo={p.canUndo} canRedo={p.canRedo} onUndo={p.onUndo} onRedo={p.onRedo} />
      ) : (
        <ToolRail {...tools} canUndo={p.canUndo} canRedo={p.canRedo} onUndo={p.onUndo} onRedo={p.onRedo} />
      )}
      {penMenuOpen && (
        <PenSettings
          tool={tool}
          setTool={setTool}
          anchorY={penMenuY}
          left={p.variant === "sidebar" ? (p.sidebarOpen ?? true ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed) + 8 : undefined}
          onClose={closePenMenu}
        />
      )}
    </>
  );
}

interface ToolControls {
  tool: ToolState;
  colors: string[];
  color: string;
  sizes: number[];
  size: number;
  showColors: boolean;
  showSizes: boolean;
  penMenuOpen: boolean;
  pick: (kind: ToolKind, button: HTMLElement) => void;
  setColor: (c: string) => void;
  setSize: (s: number) => void;
}
interface HistoryControls {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const toolTitle = (t: (typeof TOOLS)[number]) => (t.kind === "pen" ? `${t.label} (${t.key}) — tap again for settings` : `${t.label} (${t.key})`);
const penAttrs = (t: (typeof TOOLS)[number], open: boolean) =>
  t.kind === "pen" ? { "data-pen-tool": "", "aria-haspopup": "dialog" as const, "aria-expanded": open } : {};

function ToolRail({ tool, colors, color, sizes, size, showColors, showSizes, penMenuOpen, pick, setColor, setSize, canUndo, canRedo, onUndo, onRedo }: ToolControls & HistoryControls) {
  return (
    <aside className="tool-rail fixed left-3 top-1/2 z-40 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col items-center gap-2 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/90 p-1.5 shadow-lift backdrop-blur-md">
      <div className="flex flex-col gap-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.kind}
            title={toolTitle(t)}
            aria-label={t.label}
            aria-pressed={tool.kind === t.kind}
            {...penAttrs(t, penMenuOpen)}
            onClick={(e) => pick(t.kind, e.currentTarget)}
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
        <button className="icon-btn h-10 w-11 text-lg" disabled={!canUndo} onClick={onUndo} title="Undo (two-finger tap, ⌘Z)" aria-label="Undo">
          <Icon name="undo" />
        </button>
        <button className="icon-btn h-10 w-11 text-lg" disabled={!canRedo} onClick={onRedo} title="Redo (three-finger tap, ⇧⌘Z)" aria-label="Redo">
          <Icon name="redo" />
        </button>
      </div>
    </aside>
  );
}

/**
 * The Mac's tools, docked under the header so they never cover the page. Expanded it names each
 * tool and shows colours and sizes; collapsed it keeps the tools and undo/redo as icons.
 */
function ToolSidebar({ tool, colors, color, sizes, size, showColors, showSizes, penMenuOpen, pick, setColor, setSize, canUndo, canRedo, onUndo, onRedo, open, onToggle }: ToolControls & HistoryControls & { open: boolean; onToggle?: () => void }) {
  return (
    <aside
      className="tool-sidebar fixed bottom-0 left-0 top-14 z-40 flex flex-col gap-2 overflow-y-auto overflow-x-hidden border-r border-slate-200/80 bg-white/95 p-1.5 backdrop-blur-md transition-[width] duration-250 motion-reduce:transition-none"
      style={{ width: open ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed }}
      data-state={open ? "expanded" : "collapsed"}
      aria-label="Drawing tools"
    >
      <div className={`flex items-center ${open ? "justify-between pl-2" : "justify-center"}`}>
        {open && <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tools</span>}
        <button className="icon-btn h-9 w-9 text-lg" onClick={onToggle} aria-expanded={open} aria-label={open ? "Collapse tools" : "Expand tools"} title={open ? "Collapse tools (\\)" : "Expand tools (\\)"}>
          <Icon name="sidebar" />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.kind}
            title={toolTitle(t)}
            aria-label={t.label}
            aria-pressed={tool.kind === t.kind}
            {...penAttrs(t, penMenuOpen)}
            onClick={(e) => pick(t.kind, e.currentTarget)}
            className={`flex h-10 shrink-0 items-center gap-2.5 rounded-xl text-sm transition-colors ${open ? "px-2.5" : "w-10 justify-center self-center"} ${tool.kind === t.kind ? "bg-brand-600 text-on-accent shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}
          >
            <Icon name={t.icon} className="shrink-0 text-xl" />
            {open && <><span className="flex-1 truncate text-left font-medium">{t.label}</span><kbd className="text-xs opacity-60">{t.key}</kbd></>}
          </button>
        ))}
      </div>

      {open && showColors && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 px-1.5 pt-2.5">
          {colors.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full ring-offset-2 transition-shadow ${color === c ? "ring-2 ring-slate-400" : "ring-1 ring-black/10"}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      )}
      {open && showSizes && (
        <div className="flex gap-1 px-1">
          {sizes.map((s, i) => (
            <button
              key={i}
              onClick={() => setSize(s)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${size === s ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
              aria-label={`Size ${i + 1}`}
            >
              <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
            </button>
          ))}
        </div>
      )}
      {!open && showColors && (
        <button className="mx-auto h-6 w-6 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: color }} onClick={onToggle} aria-label="Colours and sizes" title="Colours and sizes" />
      )}

      <div className={`flex border-t border-slate-100 pt-1 ${open ? "flex-row px-1" : "flex-col items-center"}`}>
        <button className="icon-btn h-10 w-10 text-lg" disabled={!canUndo} onClick={onUndo} title="Undo (⌘Z)" aria-label="Undo">
          <Icon name="undo" />
        </button>
        <button className="icon-btn h-10 w-10 text-lg" disabled={!canRedo} onClick={onRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
          <Icon name="redo" />
        </button>
      </div>
    </aside>
  );
}
