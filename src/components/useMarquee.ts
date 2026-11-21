"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { boxFrom, boxesOverlap, type Box } from "@/lib/library";

/** Presses on these never start a rectangle selection. */
const NOT_EMPTY = "a, button, input, select, textarea, label, [data-item-id], [data-no-marquee]";
const START_PX = 5;
const EDGE_PX = 56;
const MAX_SCROLL = 18;

export type MarqueeMode = "replace" | "add" | "toggle";

/**
 * Rectangle selection: press on empty space with a mouse and drag across the cards
 * (`[data-item-id]` inside `container`). Shift adds to the selection, Cmd/Ctrl toggles. The page
 * scrolls when the pointer nears the top or bottom edge. A press that doesn't move is a click on
 * empty space. Escape abandons the drag.
 */
export function useMarquee(container: RefObject<HTMLElement | null>, handlers: {
  /** The drag passed the start threshold: remember the selection to add to or toggle against. */
  onStart(): void;
  onSelect(ids: string[], mode: MarqueeMode): void;
  onEmptyClick(mode: MarqueeMode): void;
  /** Escape mid-drag: put back the selection from before it. */
  onCancel(): void;
}) {
  const [box, setBox] = useState<Box | null>(null);
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || e.pointerType !== "mouse" || !(e.target instanceof Element) || e.target.closest(NOT_EMPTY)) return;
    const mode: MarqueeMode = e.shiftKey ? "add" : e.metaKey || e.ctrlKey ? "toggle" : "replace";
    // Corners in page coordinates, so the box stays put while the page scrolls under it.
    const start = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    const pointer = { x: e.clientX, y: e.clientY };
    let started = false;
    let frame = 0;
    let last: string | null = null;
    const tick = () => {
      const dy = pointer.y < EDGE_PX ? -(EDGE_PX - pointer.y) : pointer.y > window.innerHeight - EDGE_PX ? pointer.y - (window.innerHeight - EDGE_PX) : 0;
      if (dy) window.scrollBy(0, Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, dy / 2)));
      const page = boxFrom(start.x, start.y, pointer.x + window.scrollX, pointer.y + window.scrollY);
      const view = { left: page.left - window.scrollX, right: page.right - window.scrollX, top: page.top - window.scrollY, bottom: page.bottom - window.scrollY };
      setBox(view);
      const ids: string[] = [];
      container.current?.querySelectorAll<HTMLElement>("[data-item-id]").forEach((el) => {
        if (boxesOverlap(view, el.getBoundingClientRect())) ids.push(el.dataset.itemId!);
      });
      const key = ids.join();
      if (key !== last) { last = key; latest.current.onSelect(ids, mode); }
      frame = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      pointer.x = ev.clientX;
      pointer.y = ev.clientY;
      if (started || Math.hypot(ev.clientX + window.scrollX - start.x, ev.clientY + window.scrollY - start.y) < START_PX) return;
      started = true;
      window.getSelection()?.removeAllRanges();
      document.documentElement.style.userSelect = "none";
      latest.current.onStart();
      tick();
    };
    const up = () => {
      const wasStarted = started;
      stop.current();
      if (!wasStarted) latest.current.onEmptyClick(mode);
    };
    const cancel = () => stop.current();
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      stop.current();
      latest.current.onCancel();
    };
    stop.current = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.documentElement.style.userSelect = "";
      started = false;
      setBox(null);
      stop.current = () => {};
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  return { box, onPointerDown };
}
