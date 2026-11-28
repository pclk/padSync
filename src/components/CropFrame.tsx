"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Box } from "@/ink/geometry";
import { moveBoxWithin, resizeBox, type Handle } from "@/ink/resize";
import { toLocal } from "@/ink/samples";
import { ResizeHandles } from "./ResizeHandles";

// Cropping one picture by dragging (SectionView): the whole picture stays in view, dimmed outside
// the frame kept. Drag a handle to move an edge (Shift keeps the proportions, Option works about
// the centre), drag inside to slide the frame. Done, Enter or a press elsewhere on the page crops;
// Cancel or Escape leaves the picture as it was. Page units throughout.

const MIN_CROP = 8;

export function CropFrame({ image, initial, zoom, onDone }: { image: Box; initial: Box; zoom: number; onDone: (keep: Box | null) => void }) {
  const [keep, setKeep] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ what: Handle | "move"; start: [number, number]; from: Box; pointerId: number } | null>(null);
  // The latest frame and callback, for the window listeners below.
  const latest = useRef({ keep, onDone });
  useEffect(() => {
    latest.current = { keep, onDone };
  });

  useEffect(() => {
    // Before the editor's own keys: Escape would drop the selection, Backspace delete it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") latest.current.onDone(latest.current.keep);
      else if (e.key === "Escape") latest.current.onDone(null);
      else if (e.key !== "Backspace" && e.key !== "Delete") return;
      e.preventDefault();
      e.stopPropagation();
    };
    // A press anywhere else crops to the frame, as in Figma; the press then does what it does.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !bar.current?.contains(t)) latest.current.onDone(latest.current.keep);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  const local = (e: { clientX: number; clientY: number }) => toLocal(e.clientX, e.clientY, root.current!.closest("section")!.getBoundingClientRect(), zoom);
  const begin = (what: Handle | "move", e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      root.current!.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone.
    }
    drag.current = { what, start: local(e), from: keep, pointerId: e.pointerId };
    setDragging(true);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const [x, y] = local(e);
    const dx = x - d.start[0], dy = y - d.start[1];
    setKeep(d.what === "move" ? moveBoxWithin(d.from, dx, dy, image) : resizeBox(d.from, d.what, dx, dy, { keepRatio: e.shiftKey, fromCentre: e.altKey, min: MIN_CROP, within: image }));
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const w = keep.maxX - keep.minX, h = keep.maxY - keep.minY;
  const line = 1 / zoom;
  return (
    <>
      <div
        ref={root}
        data-crop-frame
        data-page-overlay
        className="absolute z-20 touch-none"
        style={{ left: image.minX, top: image.minY, width: image.maxX - image.minX, height: image.maxY - image.minY }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        {/* The dim outside the frame: the frame's shadow, cut off at the picture's edge. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ outline: `${line}px dashed rgb(148 163 184)` }}>
          <div className="absolute" style={{ left: keep.minX - image.minX, top: keep.minY - image.minY, width: w, height: h, boxShadow: "0 0 0 100000px rgb(15 23 42 / 0.5)" }} />
        </div>
        <div
          className="absolute cursor-move"
          style={{ left: keep.minX - image.minX, top: keep.minY - image.minY, width: w, height: h, outline: `${1.5 / zoom}px solid #3b82f6` }}
          onPointerDown={(e) => begin("move", e)}
          title="Drag to move the crop"
        >
          {/* Thirds while dragging, to line the crop up by. */}
          {dragging && (
            <div className="pointer-events-none absolute inset-0">
              {[1, 2].map((i) => (
                <div key={`v${i}`} className="absolute inset-y-0 bg-white/70" style={{ left: (w * i) / 3, width: line }} />
              ))}
              {[1, 2].map((i) => (
                <div key={`h${i}`} className="absolute inset-x-0 bg-white/70" style={{ top: (h * i) / 3, height: line }} />
              ))}
            </div>
          )}
          <ResizeHandles w={w} h={h} zoom={zoom} onDown={(k, e) => begin(k, e)} />
        </div>
      </div>
      {/* The bar keeps its size on screen whatever the zoom. */}
      <div
        ref={bar}
        data-page-overlay
        className="absolute z-20 origin-top-left"
        style={{ left: image.minX, top: Math.max(image.maxY, keep.maxY) + 10 / zoom, transform: `scale(${1 / zoom})` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div role="toolbar" aria-label="Crop" className="flex items-center gap-1 whitespace-nowrap rounded-xl bg-slate-900 p-1 text-sm text-white shadow-lg">
          <span className="px-2 tabular-nums text-slate-300">{Math.round(w)} × {Math.round(h)}</span>
          <button className="rounded px-3 py-1 hover:bg-slate-700" onClick={() => setKeep(image)}>Reset</button>
          <button className="rounded px-3 py-1 hover:bg-slate-700" onClick={() => onDone(null)}>Cancel</button>
          <button className="rounded bg-blue-600 px-3 py-1 font-medium hover:bg-blue-500" onClick={() => onDone(keep)}>Crop</button>
        </div>
      </div>
    </>
  );
}
