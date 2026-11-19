"use client";

import Link from "next/link";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ToolKind, ToolState } from "@/ink/controller";
import { SyncBadge } from "./SyncBadge";
import { Icon, type IconName } from "./Icons";
import { PenSettings } from "./PenSettings";
import { RailSettings } from "./RailSettings";
import { anchorOf, type PopoverAnchor } from "./popover";
import { dockStrip, tapZonePadding } from "./rail-dock";
import { ToolCircle } from "./ToolCircle";
import { RadialFan, fanAt, promptItems, useFanPress } from "./RadialFan";
import type { ChatPrompt } from "@/lib/prompts";
import { SIDEBAR_W, TOOLBAR_H, type ToolbarVariant } from "@/lib/notebook-viewport";
import { DEFAULT_RAIL, visibleItems, type RailItem, type RailLayout } from "@/lib/rail-layout";

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
  /** The iPad rail's items and dock, from its settings popover. */
  rail?: RailLayout;
  setRail?: (l: RailLayout) => void;
  /** Width covered at the right edge (the side panel), so a right-docked rail sits beside it. */
  rightInset?: number;
  /** The prompt menu's chat prompts, and what picking one does. */
  prompts?: ChatPrompt[];
  onPrompt?: (p: ChatPrompt) => void;
}

export function Toolbar(p: Props) {
  const { tool, setTool } = p;
  const colors = tool.kind === "highlighter" ? HL_COLORS : PEN_COLORS;
  const color = tool.kind === "highlighter" ? tool.hlColor : tool.penColor;
  const sizes = tool.kind === "highlighter" ? HL_SIZES : tool.kind === "eraser" ? ERASER_SIZES : PEN_SIZES;
  const size = tool.kind === "highlighter" ? tool.hlSize : tool.kind === "eraser" ? tool.eraserSize : tool.penSize;
  const rail = p.rail ?? DEFAULT_RAIL;
  const edge = p.variant === "sidebar" ? "left" : rail.dock;
  // Tapping the pen again while it is selected opens its settings (smoothness, pressure).
  const [penMenu, setPenMenu] = useState<PopoverAnchor | null>(null);
  const closePenMenu = useCallback(() => setPenMenu(null), []);
  const penMenuOpen = penMenu !== null && tool.kind === "pen";
  const [railMenu, setRailMenuState] = useState<PopoverAnchor | null>(null);
  // The settings tab to open on: Prompts when the prompt menu had none to show.
  const [railTab, setRailTab] = useState<"toolbar" | "prompts">("toolbar");
  const setRailMenu = (a: PopoverAnchor | null | ((m: PopoverAnchor | null) => PopoverAnchor | null), tab: "toolbar" | "prompts" = "toolbar") => {
    setRailTab(tab);
    setRailMenuState(a);
  };
  const closeRailMenu = useCallback(() => setRailMenuState(null), []);
  // Move mode for the circle style: drag the circles anywhere; Done ends it.
  const [arranging, setArranging] = useState(false);
  // Hiding the tool in use leaves you with the pen rather than an invisible selection.
  const setRail = (l: RailLayout) => {
    p.setRail?.(l);
    if (l.hidden.includes(tool.kind)) setTool({ ...tool, kind: "pen" });
    // The settings stay open while the rail moves or changes, so they follow its gear once it has.
    requestAnimationFrame(() => {
      const gear = document.querySelector<HTMLElement>("[data-rail-settings]");
      const at = l.style === "circle" ? l.free.tools : undefined;
      if (gear) setRailMenuState((m) => (m ? anchorOf(gear, at ? (at[0] < 0.5 ? "left" : "right") : l.dock) : m));
    });
  };
  const showColors = tool.kind === "pen" || tool.kind === "highlighter";
  const showSizes = showColors || tool.kind === "eraser";

  const setColor = (c: string) => setTool(tool.kind === "highlighter" ? { ...tool, hlColor: c } : { ...tool, penColor: c });
  const setSize = (s: number) =>
    setTool(tool.kind === "highlighter" ? { ...tool, hlSize: s } : tool.kind === "eraser" ? { ...tool, eraserSize: s } : { ...tool, penSize: s });
  const pick = (kind: ToolKind, button: HTMLElement) => {
    if (kind === "pen" && tool.kind === "pen") {
      setRailMenu(null);
      setPenMenu(penMenuOpen ? null : anchorOf(button, edge));
      return;
    }
    setPenMenu(null);
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
      ) : rail.style === "circle" ? (
        <ToolCircle
          {...tools}
          selectTool={(kind) => {
            setPenMenu(null);
            setTool({ ...tool, kind });
          }}
          canUndo={p.canUndo}
          canRedo={p.canRedo}
          onUndo={p.onUndo}
          onRedo={p.onRedo}
          rail={rail}
          rightInset={p.rightInset ?? 0}
          onPenSettings={(circle, at) => {
            setRailMenu(null);
            setPenMenu(anchorOf(circle, at));
          }}
          onSettings={(circle, at, tab) => {
            setPenMenu(null);
            setRailMenu(anchorOf(circle, at), tab);
          }}
          prompts={p.prompts ?? []}
          onPrompt={p.onPrompt ?? (() => {})}
          arranging={arranging}
          setRail={setRail}
        />
      ) : (
        <ToolRail
          {...tools}
          canUndo={p.canUndo}
          canRedo={p.canRedo}
          onUndo={p.onUndo}
          onRedo={p.onRedo}
          rail={rail}
          rightInset={p.rightInset ?? 0}
          prompts={p.prompts ?? []}
          onPrompt={p.onPrompt ?? (() => {})}
          onNoPrompts={(button) => setRailMenu(anchorOf(button, rail.dock), "prompts")}
          settingsOpen={railMenu !== null}
          onSettings={(button) => {
            setPenMenu(null);
            setRailMenu(railMenu ? null : anchorOf(button, rail.dock));
          }}
        />
      )}
      {penMenuOpen && <PenSettings tool={tool} setTool={setTool} anchor={penMenu} onClose={closePenMenu} />}
      {railMenu && (
        <RailSettings
          key={railTab}
          layout={rail}
          setLayout={setRail}
          anchor={railMenu}
          onClose={closeRailMenu}
          initialTab={railTab}
          onArrange={() => {
            setRailMenu(null);
            setPenMenu(null);
            setArranging(true);
          }}
        />
      )}
      {arranging && rail.style === "circle" && p.variant !== "sidebar" && (
        <div role="status" className="fixed inset-x-0 top-[4.25rem] z-50 flex justify-center px-3">
          <div className="card flex max-w-full items-center gap-2 py-1.5 pl-4 pr-1.5 shadow-lift">
            <span className="min-w-0 text-sm text-slate-700">Drag the circles where you want them</span>
            <button className="btn btn-ghost h-11 px-3" disabled={!rail.free.tools && !rail.free.prompts} onClick={() => setRail({ ...rail, free: {} })}>
              Dock them
            </button>
            <button className="btn btn-primary h-11 px-4" onClick={() => setArranging(false)}>
              Done
            </button>
          </div>
        </div>
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

interface RailControls {
  prompts: ChatPrompt[];
  onPrompt: (p: ChatPrompt) => void;
  /** The prompt button was pressed with no prompts to show. */
  onNoPrompts: (button: HTMLElement) => void;
  rail: RailLayout;
  rightInset: number;
  settingsOpen: boolean;
  onSettings: (button: HTMLElement) => void;
}

/** How far past a control's edge a tap still counts as that control, in CSS px. */
const TAP_REACH = 32;
/** A press that moves further than this is a scroll, not a tap. */
const TAP_SLOP = 10;

/**
 * Taps that land on the rail but not on a button (its padding, the gaps between buttons, or the
 * invisible margin around it) go to the closest enabled button within TAP_REACH, so a finger
 * that is a little off still hits something. Presses on a button are left to the button.
 */
function useGenerousTaps() {
  const down = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    down.current = (e.target as Element).closest("button, input, label") ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = down.current;
    down.current = null;
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;
    const best = nearestButton(e.currentTarget, e.clientX, e.clientY);
    if (best) {
      e.preventDefault();
      best.click();
    }
  };
  const onPointerCancel = () => (down.current = null);
  return { onPointerDown, onPointerUp, onPointerCancel };
}

export function nearestButton(root: HTMLElement, x: number, y: number): HTMLButtonElement | null {
  let best: HTMLButtonElement | null = null;
  let bestD = TAP_REACH;
  for (const b of root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")) {
    if (b.closest('[aria-hidden="true"]')) continue;
    const r = b.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d <= bestD) [best, bestD] = [b, d];
  }
  return best;
}

function ToolRail({ tool, colors, color, sizes, size, showColors, showSizes, penMenuOpen, pick, setColor, setSize, canUndo, canRedo, onUndo, onRedo, rail, rightInset, settingsOpen, onSettings, prompts, onPrompt, onNoPrompts }: ToolControls & HistoryControls & RailControls) {
  const row = rail.dock === "bottom";
  const taps = useGenerousTaps();
  // Runs of tools stay together; colours, sizes and undo/redo are each their own group.
  const groups: RailItem[][] = [];
  for (const item of visibleItems(rail)) {
    const last = groups[groups.length - 1];
    if (TOOLS.some((t) => t.kind === item) && last && TOOLS.some((t) => t.kind === last[0])) last.push(item);
    else groups.push([item]);
  }
  const flow = row ? "flex-row" : "flex-col";
  const divider = row ? "border-l border-slate-100 pl-2" : "border-t border-slate-100 pt-2";

  const renderGroup = (group: RailItem[]) => {
    const item = group[0];
    if (item === "colors") {
      // Colour and size slots are always laid out (hidden when the tool has none) so the rail
      // keeps one size and nothing moves under your finger when you switch tools. Each swatch's
      // button is bigger than its dot, so the dot needn't be hit exactly.
      return (
        <div className={`flex ${flow} items-center ${showColors ? "" : "invisible"}`} aria-hidden={!showColors}>
          {Array.from({ length: COLOR_SLOTS }, (_, i) => {
            const c = colors[i];
            if (!c) return <span key={`empty${i}`} className="flex h-9 w-11"><span className="h-7 w-7" /></span>;
            return (
              <button key={c} onClick={() => setColor(c)} tabIndex={showColors ? 0 : -1} className="flex h-9 w-11 items-center justify-center" aria-label={`Color ${c}`}>
                <span className={`h-7 w-7 rounded-full ring-offset-2 transition-shadow ${color === c ? "ring-2 ring-slate-400" : "ring-1 ring-black/10"}`} style={{ background: c }} />
              </button>
            );
          })}
        </div>
      );
    }
    if (item === "sizes") {
      return (
        <div className={`flex ${flow} items-center gap-0.5 ${showSizes ? "" : "invisible"}`} aria-hidden={!showSizes}>
          {sizes.map((s, i) => (
            <button
              key={i}
              onClick={() => setSize(s)}
              tabIndex={showSizes ? 0 : -1}
              className={`flex h-10 w-11 items-center justify-center rounded-lg ${size === s ? "bg-slate-100 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
              aria-label={`Size ${i + 1}`}
            >
              <span className="rounded-full bg-slate-700" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
            </button>
          ))}
        </div>
      );
    }
    if (item === "prompts") return <PromptButton prompts={prompts} onPrompt={onPrompt} onEmpty={onNoPrompts} />;
    if (item === "history") {
      return (
        <div className={`flex ${flow}`}>
          <button className="icon-btn h-11 w-11 text-lg" disabled={!canUndo} onClick={onUndo} title="Undo (two-finger tap, ⌘Z)" aria-label="Undo">
            <Icon name="undo" />
          </button>
          <button className="icon-btn h-11 w-11 text-lg" disabled={!canRedo} onClick={onRedo} title="Redo (three-finger tap, ⇧⌘Z)" aria-label="Redo">
            <Icon name="redo" />
          </button>
        </div>
      );
    }
    return (
      <div className={`flex ${flow} gap-0.5`}>
        {group.map((kind) => {
          const t = TOOLS.find((x) => x.kind === kind)!;
          return (
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
          );
        })}
      </div>
    );
  };

  // The tap zone's padding is the invisible margin where taps still reach the closest button.
  const strip = dockStrip(rail, rightInset);
  return (
    <div className={strip.className} style={strip.style} data-dock={rail.dock}>
      <div data-tap-zone="" className={`pointer-events-auto flex touch-manipulation ${tapZonePadding(rail)}`} {...taps}>
        <aside
          className={`tool-rail flex ${flow} items-center gap-2 rounded-2xl border border-slate-200/80 bg-white/90 p-1.5 shadow-lift backdrop-blur-md ${row ? "overflow-x-auto" : "overflow-y-auto"}`}
          style={row ? { maxWidth: `calc(100vw - ${rightInset}px - 1.5rem)` } : { maxHeight: `calc(100dvh - ${TOOLBAR_H}px - 1.5rem)` }}
          aria-label="Drawing tools"
        >
          {groups.map((g, i) => (
            <div key={g[0]} className={`shrink-0 ${i > 0 ? divider : ""}`}>
              {renderGroup(g)}
            </div>
          ))}
          <button
            className={`icon-btn h-9 w-11 shrink-0 text-base ${settingsOpen ? "bg-slate-100 text-slate-900" : ""}`}
            onClick={(e) => onSettings(e.currentTarget)}
            data-rail-settings=""
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="Toolbar settings"
            title="Toolbar settings"
          >
            <Icon name="settings" />
          </button>
        </aside>
      </div>
    </div>
  );
}

/**
 * The bar's prompt menu: a tap fans the chat prompts out around the button to be tapped; holding
 * it and dragging towards one picks it on release, as on the circle toolbar.
 */
function PromptButton({ prompts, onPrompt, onEmpty }: { prompts: ChatPrompt[]; onPrompt: (p: ChatPrompt) => void; onEmpty: (button: HTMLElement) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const open = (sticky: boolean) => {
    const el = ref.current;
    if (!el) return null;
    // No prompts left: open the settings where they are added.
    if (!prompts.length) {
      onEmpty(el);
      return null;
    }
    const r = el.getBoundingClientRect();
    return fanAt(promptItems(prompts), [r.left + r.width / 2, r.top + r.height / 2], sticky);
  };
  const pick = (key: string) => {
    const pr = prompts.find((x) => x.id === key);
    if (pr) onPrompt(pr);
  };
  const press = useFanPress({ open: () => open(false), onPick: (item) => pick(item.key), onTap: () => press.setFan(press.fan ? null : open(true)) });
  return (
    <>
      <button
        ref={ref}
        className="icon-btn h-11 w-11 touch-none text-xl text-brand-700"
        aria-label="Chat prompts"
        title="Chat prompts: tap to choose, or hold and drag towards one"
        aria-haspopup="menu"
        aria-expanded={press.fan !== null}
        {...press.handlers}
        // A click with no pointer detail is the keyboard, or a near-miss tap the rail forwarded.
        onClick={(e) => e.detail === 0 && press.setFan(press.fan ? null : open(true))}
      >
        <Icon name="message" />
      </button>
      {press.fan && (
        <RadialFan
          fan={press.fan}
          label="Chat prompts"
          onPick={(item) => {
            press.close();
            pick(item.key);
          }}
          onClose={press.close}
        />
      )}
    </>
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
