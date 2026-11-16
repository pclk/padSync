"use client";

import Link from "next/link";
import type { ToolKind, ToolState } from "@/ink/controller";
import { SyncBadge } from "./SyncBadge";

const PEN_COLORS = ["#111827", "#1d4ed8", "#dc2626", "#047857", "#7c3aed"];
const HL_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"];
const PEN_SIZES = [2.2, 3.4, 5.5];
const HL_SIZES = [14, 22, 32];
const ERASER_SIZES = [12, 24, 48];

const TOOLS: { kind: ToolKind; label: string; icon: string; key: string }[] = [
  { kind: "pen", label: "Pen", icon: "✒︎", key: "P" },
  { kind: "highlighter", label: "Highlighter", icon: "▍", key: "H" },
  { kind: "eraser", label: "Eraser", icon: "⌫", key: "E" },
  { kind: "lasso", label: "Lasso", icon: "◌", key: "L" },
  { kind: "text", label: "Text", icon: "T", key: "T" },
];

interface Props {
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

  return (
    <header className="toolbar fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/95 px-3 backdrop-blur">
      <Link href="/" className="rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" aria-label="Library">
        ‹ Library
      </Link>
      <div className="mr-2 max-w-[22ch] truncate text-sm font-medium text-slate-800">{p.title}</div>

      <div className="mx-auto flex items-center gap-1">
        <div className="flex rounded-xl bg-slate-100 p-1">
          {TOOLS.map((t) => (
            <button
              key={t.kind}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool({ ...tool, kind: t.kind })}
              className={`h-10 w-11 rounded-lg text-lg ${tool.kind === t.kind ? "bg-white text-slate-900 shadow" : "text-slate-500"}`}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {showColors && (
          <div className="ml-2 flex items-center gap-1.5">
            {colors.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-full border-2 ${color === c ? "border-slate-900" : "border-transparent"}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        )}
        {showSizes && (
          <div className="ml-2 flex items-center gap-1">
            {sizes.map((s, i) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${size === s ? "bg-slate-200" : ""}`}
                aria-label={`Size ${i + 1}`}
              >
                <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
              </button>
            ))}
          </div>
        )}

        <div className="ml-3 flex">
          <button className="h-10 w-10 rounded-lg text-lg text-slate-600 disabled:opacity-30" disabled={!p.canUndo} onClick={p.onUndo} title="Undo (two-finger tap)">
            ↶
          </button>
          <button className="h-10 w-10 rounded-lg text-lg text-slate-600 disabled:opacity-30" disabled={!p.canRedo} onClick={p.onRedo} title="Redo (three-finger tap)">
            ↷
          </button>
        </div>
      </div>

      <button className="rounded-lg px-2 py-1 text-xs tabular-nums text-slate-500 hover:bg-slate-100" onClick={p.onZoomReset} title="Reset zoom">
        {Math.round(p.zoom * 100)}%
      </button>
      <SyncBadge />
      <button
        className={`rounded-lg px-3 py-2 text-sm ${p.panelOpen ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
        onClick={p.onTogglePanel}
      >
        Panel
      </button>
    </header>
  );
}
