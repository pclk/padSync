"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { HANDLES, HANDLE_AT, HANDLE_CURSOR, isCorner, type Handle } from "@/ink/resize";

// The eight squares on a box's corners and sides, Figma style, for the selection's resize and the
// crop frame. Laid out in page units inside the box; sized by the zoom so they stay the same on
// screen. The hit area is larger than the square so a finger or the Pencil finds it too.

const SQUARE = 9;
const HIT = 26;
/** Below this on screen a side's middle handle would crowd its corners, so only corners show. */
const SIDE_MIN = 56;

export function ResizeHandles({ w, h, zoom, onDown }: { w: number; h: number; zoom: number; onDown: (handle: Handle, e: ReactPointerEvent<HTMLElement>) => void }) {
  const hit = HIT / zoom, sq = SQUARE / zoom;
  return HANDLES.filter((k) => isCorner(k) || ((k === "n" || k === "s") ? w * zoom >= SIDE_MIN : h * zoom >= SIDE_MIN)).map((k) => (
    <div
      key={k}
      data-handle={k}
      aria-hidden
      className="pointer-events-auto absolute z-10 touch-none"
      style={{ left: HANDLE_AT[k][0] * w - hit / 2, top: HANDLE_AT[k][1] * h - hit / 2, width: hit, height: hit, cursor: HANDLE_CURSOR[k] }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onDown(k, e);
      }}
    >
      <span
        className="absolute rounded-[2px] border-blue-500 bg-white shadow-sm"
        style={{ left: (hit - sq) / 2, top: (hit - sq) / 2, width: sq, height: sq, borderWidth: 1.5 / zoom, borderStyle: "solid" }}
      />
    </div>
  ));
}
