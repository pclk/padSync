"use client";

import { useCallback, useLayoutEffect, useState } from "react";
import type { Selection } from "@/ink/controller";
import { LASSO_ACTIONS, visibleLassoActions, type LassoAction, type LassoSettings } from "@/lib/lasso-settings";
import { TOOLBAR_H } from "@/lib/notebook-viewport";
import type { ChatPrompt } from "@/lib/prompts";
import { Icon } from "./Icons";
import { RadialFan, fanAt, promptItems, useFanPress, type FanItem, type FanState } from "./RadialFan";
import { PEN_COLORS, PEN_COLOR_NAMES } from "./Toolbar";

interface Props {
  selection: Selection;
  /** The section the selection is in, on screen (scaled by the zoom). */
  sectionEl: (id: string) => HTMLElement | undefined;
  zoom: number;
  settings: LassoSettings;
  prompts: ChatPrompt[];
  /** Delete, duplicate, bigger, smaller, done. */
  onAction: (a: LassoAction) => void;
  onRecolor: (color: string) => void;
  /** A prompt picked from Ask AI, to send with the selection. */
  onPrompt: (p: ChatPrompt) => void;
  onNote: (text: string) => void;
}

/** Air between the selection box and the circle. */
const GAP = 14;

/**
 * The circle of lasso actions, floating just above the selection (below it when there is no room
 * above). Like the toolbar circles: hold and drag towards an action and let go, or tap to fan
 * them out and tap one. Colour and Ask AI open a second fan, of pen colours or of prompts.
 */
export function LassoCircle(p: Props) {
  const { selection, sectionEl, zoom, settings } = p;
  const d = settings.size;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // A second fan (colours or prompts) opened from the first, around the same circle.
  const [sub, setSubState] = useState<{ kind: "color" | "ask"; fan: FanState } | null>(null);
  const closeSub = useCallback(() => setSubState(null), []);

  // Follows the selection on screen as the page scrolls, zooms or the box moves.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = sectionEl(selection.sectionId);
      if (!el) return setAt(null);
      const r = el.getBoundingClientRect();
      const { box } = selection;
      const top = r.top + box.minY * zoom;
      const bottom = r.top + box.maxY * zoom;
      const x = Math.min(window.innerWidth - d / 2 - 8, Math.max(d / 2 + 8, r.left + ((box.minX + box.maxX) / 2) * zoom));
      const above = top - GAP - d / 2;
      setAt({ x, y: above - d / 2 >= TOOLBAR_H + 8 ? above : Math.min(window.innerHeight - d / 2 - 8, bottom + GAP + d / 2) });
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
    };
  }, [selection, sectionEl, zoom, d]);

  const center = (): [number, number] | null => (at ? [at.x, at.y] : null);
  const items = (): FanItem[] =>
    visibleLassoActions(settings).map((a) => {
      const info = LASSO_ACTIONS.find((x) => x.action === a)!;
      return { key: a, label: info.label, icon: info.icon };
    });
  const pick = (a: LassoAction) => {
    const c = center();
    if (a === "recolor" && c) {
      const colors = PEN_COLORS.map((col) => ({ key: col, label: PEN_COLOR_NAMES[col] ?? col, icon: "sparkles" as const, color: col }));
      return setSubState({ kind: "color", fan: fanAt(colors, c, true) });
    }
    if (a === "ask" && c) {
      if (!p.prompts.length) return p.onNote("No prompts: add some in toolbar settings → Prompts");
      return setSubState({ kind: "ask", fan: fanAt(promptItems(p.prompts), c, true) });
    }
    p.onAction(a);
  };
  const press = useFanPress({
    open: () => {
      const c = center();
      setSubState(null);
      return c && items().length ? fanAt(items(), c) : null;
    },
    onPick: (item) => pick(item.key as LassoAction),
    onTap: () => {
      const c = center();
      setSubState(null);
      press.setFan(press.fan || !c ? null : fanAt(items(), c, true));
    },
  });
  if (!at) return null;
  return (
    <>
      <div
        data-tap-zone=""
        className="lasso-circle pointer-events-auto fixed z-40 -translate-x-1/2 -translate-y-1/2 touch-none select-none p-3"
        style={{ left: at.x, top: at.y, WebkitTouchCallout: "none" }}
        {...press.handlers}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          className="flex items-center justify-center rounded-full border border-blue-200 bg-white/95 text-blue-700 shadow-lift backdrop-blur-md"
          style={{ width: d, height: d, fontSize: Math.round(d * 0.42) }}
          aria-label={`Selection: ${selection.ids.size} stroke${selection.ids.size === 1 ? "" : "s"}. Tap for actions, or hold and drag towards one`}
          aria-haspopup="menu"
          aria-expanded={press.fan !== null || sub !== null}
          onClick={(e) => e.detail === 0 && press.setFan(press.fan ? null : fanAt(items(), [at.x, at.y], true))}
        >
          <Icon name="lasso" />
        </button>
      </div>
      {press.fan && (
        <RadialFan
          fan={press.fan}
          label="Selection"
          onPick={(item) => {
            press.close();
            pick(item.key as LassoAction);
          }}
          onClose={press.close}
        />
      )}
      {sub && (
        <RadialFan
          fan={sub.fan}
          label={sub.kind === "color" ? "Colour" : "Ask AI"}
          onPick={(item) => {
            setSubState(null);
            if (sub.kind === "color") return p.onRecolor(item.key);
            const pr = p.prompts.find((x) => x.id === item.key);
            if (pr) p.onPrompt(pr);
          }}
          onClose={closeSub}
        />
      )}
    </>
  );
}
