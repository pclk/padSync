"use client";

import { useLayoutEffect, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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
  /** Delete, duplicate, bigger, smaller. */
  onAction: (a: LassoAction) => void;
  /** Actions that apply to this selection (Copy image needs a drawn rectangle, Crop a selected image). */
  available?: (a: LassoAction) => boolean;
  onRecolor: (color: string) => void;
  /** A prompt picked from Ask AI, to send with the selection. */
  onPrompt: (p: ChatPrompt) => void;
  onNote: (text: string) => void;
}

/** Air between the selection box and the circle. */
const GAP = 14;

/**
 * The control floating just above a selection (below it when there is no room above). With Ask AI
 * shown it is a pill: Ask AI, whose press fans out the prompts straight away, and ⋯ for the rest of
 * the actions; with Ask AI hidden, just the lasso circle. Like the toolbar circles: hold and drag
 * towards an item and let go, or tap to fan them out and tap one. Colour opens a second fan.
 */
export function LassoCircle(p: Props) {
  const { selection, sectionEl, zoom, settings } = p;
  const d = settings.size;
  const visible = visibleLassoActions(settings);
  const ask = visible.includes("ask");
  const edits = visible.filter((a) => a !== "ask" && (p.available?.(a) ?? true));
  // The Ask AI segment fits its icon and label; ⋯ (or the lone circle) is a circle of the set size.
  const askW = ask ? Math.round(d * 2.1) : 0;
  const editW = edits.length || !ask ? d : 0;
  const width = askW + editW;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [colors, setColors] = useState<FanState | null>(null);
  const closeColors = () => setColors(null);

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
      const x = Math.min(window.innerWidth - width / 2 - 8, Math.max(width / 2 + 8, r.left + ((box.minX + box.maxX) / 2) * zoom));
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
  }, [selection, sectionEl, zoom, d, width]);

  // Each fan opens around the segment that was pressed.
  const askAt = (): [number, number] | null => (at ? [at.x - width / 2 + askW / 2, at.y] : null);
  const editAt = (): [number, number] | null => (at ? [at.x + width / 2 - editW / 2, at.y] : null);
  const editItems = (): FanItem[] =>
    edits.map((a) => {
      const info = LASSO_ACTIONS.find((x) => x.action === a)!;
      return { key: a, label: info.label, icon: info.icon };
    });
  const pickEdit = (a: LassoAction) => {
    const c = editAt();
    if (a === "recolor" && c) {
      const items = PEN_COLORS.map((col) => ({ key: col, label: PEN_COLOR_NAMES[col] ?? col, icon: "sparkles" as const, color: col }));
      return setColors(fanAt(items, c, true));
    }
    p.onAction(a);
  };
  const pickPrompt = (key: string) => {
    const pr = p.prompts.find((x) => x.id === key);
    if (pr) p.onPrompt(pr);
  };
  const noPrompts = () => p.onNote("No prompts: add some in toolbar settings → Prompts");

  const editPress = useFanPress({
    open: () => {
      const c = editAt();
      return c && edits.length ? fanAt(editItems(), c) : null;
    },
    onPick: (item) => pickEdit(item.key as LassoAction),
    onTap: () => {
      const c = editAt();
      editPress.setFan(editPress.fan || !c || !edits.length ? null : fanAt(editItems(), c, true));
    },
  });
  const askPress = useFanPress({
    open: () => {
      const c = askAt();
      return c && p.prompts.length ? fanAt(promptItems(p.prompts), c) : null;
    },
    onPick: (item) => pickPrompt(item.key),
    onTap: () => {
      const c = askAt();
      if (!p.prompts.length) return noPrompts();
      askPress.setFan(askPress.fan || !c ? null : fanAt(promptItems(p.prompts), c, true));
    },
  });
  // A press on one segment closes whatever the other opened, so one fan shows at a time.
  const handlers = (press: typeof askPress, other: typeof askPress) => ({
    ...press.handlers,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      other.close();
      setColors(null);
      press.handlers.onPointerDown(e);
    },
  });
  if (!at) return null;
  const n = selection.ids.size;
  const what = `${n} stroke${n === 1 ? "" : "s"} selected`;
  // Keyboard and VoiceOver clicks (no pointer press) toggle the fan.
  const toggle = (press: typeof askPress, items: () => FanItem[], c: [number, number] | null) => (e: ReactMouseEvent) => {
    if (e.detail !== 0 || !c) return;
    if (press === askPress && !p.prompts.length) return noPrompts();
    press.setFan(press.fan ? null : fanAt(items(), c, true));
  };
  return (
    <>
      <div
        data-tap-zone=""
        className="lasso-circle pointer-events-auto fixed z-40 flex -translate-x-1/2 -translate-y-1/2 touch-none select-none overflow-visible rounded-full border border-blue-200 bg-white/95 shadow-lift backdrop-blur-md"
        style={{ left: at.x, top: at.y, height: d, width, WebkitTouchCallout: "none" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ask && (
          <button
            // The pseudo-element widens the press area past the pill's edge, as the old padding did.
            className="relative flex h-full items-center justify-center gap-1.5 rounded-full font-semibold text-brand-700 before:absolute before:-inset-y-3 before:-left-3 before:right-0 before:content-['']"
            style={{ width: askW, fontSize: Math.round(d * 0.3) }}
            aria-label={`Ask AI about the ${what}. Tap for prompts, or hold and drag towards one`}
            aria-haspopup="menu"
            aria-expanded={askPress.fan !== null}
            {...handlers(askPress, editPress)}
            onClick={toggle(askPress, () => promptItems(p.prompts), askAt())}
          >
            <Icon name="message" style={{ fontSize: Math.round(d * 0.4) }} />
            Ask AI
          </button>
        )}
        {ask && editW > 0 && <span aria-hidden="true" className="my-2.5 w-px shrink-0 bg-blue-100" />}
        {editW > 0 && (
          <button
            className={`relative flex h-full shrink-0 items-center justify-center rounded-full text-blue-700 before:absolute before:-inset-y-3 before:-right-3 before:content-[''] ${ask ? "before:left-0" : "before:-left-3"}`}
            style={{ width: editW - (ask ? 1 : 0), fontSize: Math.round(d * 0.42) }}
            aria-label={ask ? `More actions for the ${what}` : `Selection: ${what}. Tap for actions, or hold and drag towards one`}
            aria-haspopup="menu"
            aria-expanded={editPress.fan !== null || colors !== null}
            {...handlers(editPress, askPress)}
            onClick={toggle(editPress, editItems, editAt())}
          >
            <Icon name={ask ? "more" : "lasso"} />
          </button>
        )}
      </div>
      {askPress.fan && (
        <RadialFan
          fan={askPress.fan}
          label="Ask AI"
          keep=".lasso-circle"
          onPick={(item) => {
            askPress.close();
            pickPrompt(item.key);
          }}
          onClose={askPress.close}
        />
      )}
      {editPress.fan && (
        <RadialFan
          fan={editPress.fan}
          label="Selection"
          keep=".lasso-circle"
          onPick={(item) => {
            editPress.close();
            pickEdit(item.key as LassoAction);
          }}
          onClose={editPress.close}
        />
      )}
      {colors && (
        <RadialFan
          fan={colors}
          label="Colour"
          keep=".lasso-circle"
          onPick={(item) => {
            setColors(null);
            p.onRecolor(item.key);
          }}
          onClose={closeColors}
        />
      )}
    </>
  );
}
