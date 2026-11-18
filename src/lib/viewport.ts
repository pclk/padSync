import { PAGE_WIDTH } from "./types";

// Every zoom path (trackpad pinch, two-finger pinch, the reset button, the Mac's fit, a restored
// zoom) goes through clampZoom, so 25%..300% holds everywhere.
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export function clampZoom(z: number, fallback = 1): number {
  const v = Number.isFinite(z) ? z : fallback; // a fit with no room left is 0: the floor, not 100%
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v));
}
// A stored zoom is restored only if it is a real number; anything else means "no saved zoom".
export function parseZoom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? clampZoom(value) : null;
}

// Clear space kept between the page and whatever covers the screen edges.
export const PAGE_GUTTER = 16;
// The Mac's floating tool rail: left-3 plus the rail's 70 px. Stage 2 turns it into a togglable
// sidebar, which passes its own width (or 0 when hidden) as the left inset.
export const DESKTOP_RAIL_INSET = 82;

/** Screen edges covered by fixed chrome: the tool rail or sidebar on the left, the side panel on the right. */
export interface Insets { left: number; right: number }

export function notebookInsets(o: { isIpad: boolean; panelOpen: boolean; panelWidth: number; toolInset?: number }): Insets {
  // The iPad keeps its floating rail over the page as before; only the side panel is kept clear.
  const left = o.isIpad ? 0 : (o.toolInset ?? DESKTOP_RAIL_INSET);
  return { left, right: o.panelOpen ? o.panelWidth : 0 };
}

/** Width left for the page between the insets, less a gutter on each side. */
export function regionWidth(viewportWidth: number, insets: Insets) {
  return Math.max(0, viewportWidth - insets.left - insets.right - 2 * PAGE_GUTTER);
}

/** The zoom that fits the page's width into the free region (never above 100%). */
export function fitZoom(viewportWidth: number, insets: Insets, pageWidth = PAGE_WIDTH) {
  return clampZoom(Math.min(1, regionWidth(viewportWidth, insets) / pageWidth));
}

/**
 * Width of the editor's scroll area. A page wider than the free region (zoomed in, or a narrow
 * window beside a wide chat panel) widens the document instead of sliding under the panel, so
 * horizontal scrolling reaches both of its edges.
 */
export function stageWidth(viewportWidth: number, insets: Insets, pagePx: number) {
  return Math.max(viewportWidth, stageMinWidth(insets, pagePx));
}
/** The narrowest the editor may be and still show the whole page between the insets. */
export function stageMinWidth(insets: Insets, pagePx: number) {
  return Math.ceil(insets.left + insets.right + 2 * PAGE_GUTTER + pagePx);
}

/** Document x of the page's left edge: centred in the free region, or a gutter in from the left inset. */
export function pageLeft(viewportWidth: number, insets: Insets, pagePx: number) {
  return insets.left + PAGE_GUTTER + Math.max(0, (regionWidth(viewportWidth, insets) - pagePx) / 2);
}
