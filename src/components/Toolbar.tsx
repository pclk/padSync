"use client";

import Link from "next/link";
import type { ToolKind, ToolState } from "@/ink/controller";
import { SyncBadge } from "./SyncBadge";

const PEN_COLORS = ["#111827", "#1d4ed8", "#dc2626", "#047857", "#7c3aed"];
const HL_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"];
const PEN_SIZES = [2.2, 3.4, 5.5];
const HL_SIZES = [14, 22, 32];
const ERASER_SIZES = [12, 24, 48];
const COLOR_SLOTS = Math.max(PEN_COLORS.length, HL_COLORS.length);

const TOOLS: { kind: ToolKind; label: string; icon: string; key: string }[] = [
  { kind: "pen", label: "Pen", icon: "✒︎", key: "P" },
  { kind: "highlighter", label: "Highlighter", icon: "▍", key: "H" },
  { kind: "eraser", label: "Eraser", icon: "⌫", key: "E" },
  { kind: "lasso", label: "Lasso", icon: "◌", key: "L" },
  { kind: "text", label: "Text", icon: "T", key: "T" },
];

interface Props {
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
  const showColors = tool.kind === "pen" || tool.kind === "highlighter";
  const showSizes = showColors || tool.kind === "eraser";

  const setColor = (c: string) => setTool(tool.kind === "highlighter" ? { ...tool, hlColor: c } : { ...tool, penColor: c });
  const setSize = (s: number) =>
    setTool(tool.kind === "highlighter" ? { ...tool, hlSize: s } : tool.kind === "eraser" ? { ...tool, eraserSize: s } : { ...tool, penSize: s });

  // The top bar keeps navigation and status; the drawing tools sit in a rail on the left edge,
  // within thumb reach while the other hand holds the Pencil.
  return (
    <>
      <header className="toolbar fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur">
        <Link href="/" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" aria-label="Library">
          ‹ Library
        </Link>
        <div className="mr-auto max-w-[40ch] truncate text-sm font-medium text-slate-800">{p.title}</div>

        <button className="rounded-lg px-2 py-1 text-xs tabular-nums text-slate-500 hover:bg-slate-100" onClick={p.onZoomReset} title="Reset zoom">
          {Math.round(p.zoom * 100)}%
        </button>
        {p.notebookId && <Link href={`/import?notebookId=${encodeURIComponent(p.notebookId)}`} className="rounded-lg px-2 py-1 text-xs text-blue-700">AI & PDFs</Link>}
        <SyncBadge />
        <button
          className={`rounded-lg px-3 py-2 text-sm ${p.panelOpen ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          onClick={p.onTogglePanel}
        >
          Panel
        </button>
      </header>

      <aside className="tool-rail fixed left-3 top-1/2 z-40 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col items-center gap-2 overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-lg backdrop-blur">
        <div className="flex flex-col rounded-xl bg-slate-100 p-1">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool({ ...tool, kind: t.kind })}
              className={`h-11 w-10 rounded-lg text-lg ${tool.kind === t.kind ? "bg-white text-slate-900 shadow" : "text-slate-500"}`}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {/* Colour and size slots are always laid out (hidden when the tool has none) so the rail
            keeps one height and nothing moves under your finger when you switch tools. */}
        <div className={`flex flex-col items-center gap-1.5 ${showColors ? "" : "invisible"}`} aria-hidden={!showColors}>
          {Array.from({ length: COLOR_SLOTS }, (_, i) => {
            const c = colors[i];
            if (!c) return <span key={`empty${i}`} className="h-8 w-8" />;
            return (
              <button
                key={c}
                onClick={() => setColor(c)}
                tabIndex={showColors ? 0 : -1}
                className={`h-8 w-8 rounded-full border-2 ${color === c ? "border-slate-900" : "border-transparent"}`}
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
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${size === s ? "bg-slate-200" : ""}`}
              aria-label={`Size ${i + 1}`}
            >
              <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
            </button>
          ))}
        </div>

        <div className="flex flex-col border-t border-slate-200 pt-1">
          <button className="h-10 w-10 rounded-lg text-lg text-slate-600 disabled:opacity-30" disabled={!p.canUndo} onClick={p.onUndo} title="Undo (two-finger tap, ⌘Z)">
            ↶
          </button>
          <button className="h-10 w-10 rounded-lg text-lg text-slate-600 disabled:opacity-30" disabled={!p.canRedo} onClick={p.onRedo} title="Redo (three-finger tap, ⇧⌘Z)">
            ↷
          </button>
        </div>
      </aside>
    </>
  );
}
