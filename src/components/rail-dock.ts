import type { CSSProperties } from "react";
import { TOOLBAR_H } from "@/lib/notebook-viewport";
import type { RailLayout } from "@/lib/rail-layout";

const JUSTIFY = { start: "justify-start", center: "justify-center", end: "justify-end" } as const;

/**
 * The strip along the docked edge that holds the bar or the circle, placed at the start, middle or
 * end of it. It passes touches through; only the tap zone inside it takes them.
 */
export function dockStrip(rail: RailLayout, rightInset: number): { className: string; style: CSSProperties } {
  const row = rail.dock === "bottom";
  const cross = row ? "items-end" : rail.dock === "left" ? "items-start" : "items-end";
  return {
    className: `tool-rail-dock pointer-events-none fixed z-40 flex ${row ? "flex-row" : "flex-col"} ${JUSTIFY[rail.align]} ${cross}`,
    style: row ? { left: 0, right: rightInset, bottom: 0 } : { top: TOOLBAR_H, bottom: 0, ...(rail.dock === "left" ? { left: 0 } : { right: rightInset }) },
  };
}

/** The tap zone's padding: the invisible margin that still counts as the toolbar. */
export const tapZonePadding = (rail: RailLayout) => `p-3 ${rail.dock === "bottom" ? "pb-[max(0.75rem,env(safe-area-inset-bottom))]" : ""}`;
