"use client";

import { useEffect, useState, type RefObject } from "react";
import type { RailDock } from "@/lib/rail-layout";

/** A popover opened from a toolbar button: it opens away from the edge the toolbar is docked to. */
export interface PopoverAnchor {
  edge: RailDock;
  /** The toolbar's box, in viewport px. */
  bar: { top: number; left: number; right: number; bottom: number };
  /** The button's centre. */
  x: number;
  y: number;
}

export function anchorOf(button: HTMLElement, edge: RailDock): PopoverAnchor {
  const r = button.getBoundingClientRect();
  const b = (button.closest("aside") ?? button).getBoundingClientRect();
  return { edge, bar: { top: b.top, left: b.left, right: b.right, bottom: b.bottom }, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

const GAP = 8;
const MARGIN = 12;
const HEADER = 68;

/**
 * Where the popover goes and how tall it may be, from the visible screen (visualViewport where
 * there is one, so Safari's bars and the keyboard are accounted for), kept up to date as it changes.
 * Beside a side toolbar its header lines up with the button; above a bottom one it is centred on it.
 */
export function usePopoverBox(anchor: PopoverAnchor, width: number) {
  const measure = () => {
    if (typeof window === "undefined") return { top: HEADER, maxHeight: 600 };
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const offset = vv?.offsetTop ?? 0;
    const vw = vv?.width ?? window.innerWidth;
    if (anchor.edge === "bottom") {
      const above = anchor.bar.top - GAP;
      const left = Math.max(MARGIN, Math.min(anchor.x - width / 2, vw - width - MARGIN));
      return { left, bottom: window.innerHeight - above, maxHeight: Math.max(200, above - offset - HEADER) };
    }
    // Line the header up with the button, but never so low that less than 320 px fit.
    const top = Math.max(offset + HEADER, Math.min(anchor.y - 28, offset + height - 320 - MARGIN));
    const side = anchor.edge === "left" ? { left: anchor.bar.right + GAP } : { right: window.innerWidth - anchor.bar.left + GAP };
    return { top, ...side, maxHeight: Math.max(200, offset + height - top - MARGIN) };
  };
  const [box, setBox] = useState(measure);
  useEffect(() => {
    const update = () => setBox(measure());
    const vv = window.visualViewport;
    window.addEventListener("resize", update);
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
    // measure reads anchor; re-measure when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);
  return box;
}

/** Closes on Escape or a press outside, except on `keep` (the button that toggles it itself). */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, keep: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.(keep)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [ref, onClose, keep]);
}
