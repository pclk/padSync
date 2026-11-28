"use client";

import { useCallback, useRef, useState } from "react";
import type { ToolKind, ToolState } from "@/ink/controller";
import type { ChatPrompt } from "@/lib/prompts";
import { clampPlace, isTool, visibleItems, visibleTools, type CircleKey, type RailDock, type RailLayout } from "@/lib/rail-layout";
import { Icon } from "./Icons";
import { useLassoIcon } from "@/lib/settings";
import { anchorOf, useDismiss, usePopoverBox, type PopoverAnchor } from "./popover";
import { RadialFan, fanAt, promptItems, useFanPress } from "./RadialFan";
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
  /** Open the pen's or the toolbar's settings beside the circle, opening away from `edge`. */
  onPenSettings: (circle: HTMLElement, edge: RailDock) => void;
  onSettings: (circle: HTMLElement, edge: RailDock, tab?: "prompts") => void;
  prompts: ChatPrompt[];
  onPrompt: (p: ChatPrompt) => void;
  /** Move mode: dragging a circle places it, and nothing else happens on a press. */
  arranging: boolean;
  setRail: (l: RailLayout) => void;
}

/** A circle `d` px across, its icon scaled with it. */
const circleBox = (d: number) => ({ width: d, height: d, fontSize: Math.round(d * 0.4) });

const centerOf = (el: HTMLElement): [number, number] => {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};

/**
 * The iPad's circle toolbar. Press and hold the circle (or start dragging) and the tools fan out
 * around it; move towards one and let go to pick it. Let go without pointing and the fan stays
 * open to be tapped; point back at the edge and nothing changes. A quick tap opens the current
 * tool's colours and sizes. The whole tap zone around the circle counts as the circle.
 *
 * Beside it, unless hidden, a smaller circle does the same for chat prompts; a tap on it opens
 * them to be tapped.
 */
export function ToolCircle(p: Props) {
  const lassoIcon = useLassoIcon();
  const circleRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<PopoverAnchor | null>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  const label = RAIL_ITEM_INFO[p.tool.kind].label;

  // --- moving the circles: in move mode a drag carries a circle along, and letting go places its
  // centre there. It follows the finger by a transform and only moves out of the docked strip
  // once let go, so the element under the finger stays the same through the drag.
  const [drag, setDrag] = useState<{ key: CircleKey; dx: number; dy: number } | null>(null);
  const grip = useRef<{ id: number; key: CircleKey; sx: number; sy: number; cx: number; cy: number } | null>(null);
  const placeOf = (key: CircleKey) => p.rail.free[key];
  // A popover opens away from the nearer side of a moved circle, or away from the dock.
  const edgeOf = (key: CircleKey): RailDock => {
    const at = p.rail.free[key];
    return at ? (at[0] < 0.5 ? "left" : "right") : p.rail.dock;
  };
  const shift = (key: CircleKey) => (drag?.key === key ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : {});
  // The tap zone's centre is its circle's centre; data-circle says which circle it is.
  const mover = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (grip.current) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
      const [cx, cy] = centerOf(e.currentTarget);
      const key = e.currentTarget.dataset.circle as CircleKey;
      grip.current = { id: e.pointerId, key, sx: e.clientX, sy: e.clientY, cx, cy };
      setDrag({ key, dx: 0, dy: 0 });
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const g = grip.current;
      if (g && g.id === e.pointerId) setDrag({ key: g.key, dx: e.clientX - g.sx, dy: e.clientY - g.sy });
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const g = grip.current;
      if (!g || g.id !== e.pointerId) return;
      grip.current = null;
      setDrag(null);
      const at = clampPlace((g.cx + e.clientX - g.sx) / window.innerWidth, (g.cy + e.clientY - g.sy) / window.innerHeight);
      p.setRail({ ...p.rail, free: { ...p.rail.free, [g.key]: at } });
    },
    onPointerCancel: () => {
      grip.current = null;
      setDrag(null);
    },
  };

  const togglePanel = () => {
    if (circleRef.current) setPanel(panel ? null : anchorOf(circleRef.current, edgeOf("tools")));
  };

  const tools = useFanPress({
    open: () => {
      if (!circleRef.current) return null;
      setPanel(null);
      const items = visibleTools(p.rail).map((k) => ({ key: k, label: RAIL_ITEM_INFO[k].label, icon: k === "lasso" ? lassoIcon : RAIL_ITEM_INFO[k].icon!, current: k === p.tool.kind }));
      return fanAt(items, centerOf(circleRef.current));
    },
    onPick: (item) => p.selectTool(item.key as ToolKind),
    // A quick tap: the current tool's colours and sizes.
    onTap: togglePanel,
  });
  const openPrompts = (sticky: boolean) => {
    if (!promptRef.current) return null;
    setPanel(null);
    // No prompts left: open the settings where they are added.
    if (!p.prompts.length) {
      p.onSettings(promptRef.current, edgeOf("prompts"), "prompts");
      return null;
    }
    return fanAt(promptItems(p.prompts), centerOf(promptRef.current), sticky);
  };
  const prompts = useFanPress({
    open: () => openPrompts(false),
    onPick: (item) => {
      const pr = p.prompts.find((x) => x.id === item.key);
      if (pr) p.onPrompt(pr);
    },
    onTap: () => prompts.setFan(prompts.fan ? null : openPrompts(true)),
  });

  const visible = visibleItems(p.rail);
  const showPrompts = visible.includes("prompts");
  // The prompt circle goes before the tool circle when it comes before the tools in the order.
  const promptsFirst = showPrompts && visible.indexOf("prompts") < visible.findIndex(isTool);
  const strip = dockStrip(p.rail, p.rightInset);
  const zone = `pointer-events-auto touch-none select-none ${tapZonePadding(p.rail)} ${p.arranging ? "cursor-move" : ""}`;
  // In move mode each circle is ringed with a dashed outline and drags instead of opening.
  const moving = p.arranging ? "outline-2 outline-offset-4 outline-dashed outline-brand-500" : "";
  const toolCircle = (
    <div key="tools" data-tap-zone="" data-circle="tools" className={zone} style={{ WebkitTouchCallout: "none", ...shift("tools") }} {...(p.arranging ? mover : tools.handlers)} onContextMenu={(e) => e.preventDefault()}>
      <aside ref={circleRef} data-rail-settings="" aria-label="Drawing tools" className={`tool-circle rounded-full ${moving}`}>
        {/* Pointer taps are handled by the zone; a click with no pointer detail is the keyboard. */}
        <button
          className="relative flex items-center justify-center rounded-full border border-slate-200/80 bg-white/90 text-slate-800 shadow-lift backdrop-blur-md"
          style={circleBox(p.rail.size.tools)}
          aria-label={`${label}: hold and drag to change tool, tap for colours and sizes`}
          aria-haspopup="dialog"
          aria-expanded={panel !== null}
          onClick={(e) => e.detail === 0 && togglePanel()}
        >
          <Icon name={p.tool.kind === "lasso" ? lassoIcon : RAIL_ITEM_INFO[p.tool.kind].icon!} />
          {p.showColors && (
            <span className="absolute rounded-full ring-2 ring-white" style={{ background: p.color, width: p.rail.size.tools / 5, height: p.rail.size.tools / 5, right: p.rail.size.tools / 10, bottom: p.rail.size.tools / 10 }} />
          )}
        </button>
      </aside>
    </div>
  );
  const promptCircle = showPrompts && (
    <div key="prompts" data-tap-zone="" data-circle="prompts" className={zone} style={{ WebkitTouchCallout: "none", ...shift("prompts") }} {...(p.arranging ? mover : prompts.handlers)} onContextMenu={(e) => e.preventDefault()}>
      <aside ref={promptRef} aria-label="Chat prompts" className={`rounded-full ${moving}`}>
        <button
          className="flex items-center justify-center rounded-full border border-slate-200/80 bg-white/90 text-brand-700 shadow-lift backdrop-blur-md"
          style={circleBox(p.rail.size.prompts)}
          aria-label="Chat prompts: tap to choose, or hold and drag towards one"
          aria-haspopup="menu"
          aria-expanded={prompts.fan !== null}
          onClick={(e) => e.detail === 0 && prompts.setFan(prompts.fan ? null : openPrompts(true))}
        >
          <Icon name="message" />
        </button>
      </aside>
    </div>
  );
  return (
    <>
      {/* Docked circles share the strip; the two tap zones overlap by half their padding, so the
          circles sit 12 px apart. A moved circle floats on its own, centred where it was put. */}
      <div className={`${strip.className} ${p.rail.dock === "bottom" ? "[&>*+*]:-ml-3" : "[&>*+*]:-mt-3"}`} style={strip.style} data-dock={p.rail.dock} data-style="circle">
        {(promptsFirst ? [["prompts", promptCircle], ["tools", toolCircle]] as const : [["tools", toolCircle], ["prompts", promptCircle]] as const).map(([key, el]) => !placeOf(key) && el)}
      </div>
      {(["tools", "prompts"] as const).map((key) => {
        const at = placeOf(key);
        const el = key === "tools" ? toolCircle : promptCircle;
        if (!at || !el) return null;
        return (
          <div key={key} className="fixed z-40 -translate-x-1/2 -translate-y-1/2" style={{ left: `${at[0] * 100}%`, top: `${at[1] * 100}%` }} data-placed={key}>
            {el}
          </div>
        );
      })}
      {tools.fan && <RadialFan fan={tools.fan} label="Tools" keep='[data-circle="tools"]' onPick={(item) => { p.selectTool(item.key as ToolKind); tools.close(); }} onClose={tools.close} />}
      {prompts.fan && (
        <RadialFan
          fan={prompts.fan}
          label="Chat prompts"
          keep='[data-circle="prompts"]'
          onPick={(item) => {
            prompts.close();
            const pr = p.prompts.find((x) => x.id === item.key);
            if (pr) p.onPrompt(pr);
          }}
          onClose={prompts.close}
        />
      )}
      {panel && (
        <CirclePanel
          {...p}
          label={label}
          anchor={panel}
          onClose={closePanel}
          onPenSettings={() => {
            setPanel(null);
            if (circleRef.current) p.onPenSettings(circleRef.current, edgeOf("tools"));
          }}
          onSettings={() => {
            setPanel(null);
            if (circleRef.current) p.onSettings(circleRef.current, edgeOf("tools"));
          }}
        />
      )}
    </>
  );
}

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
