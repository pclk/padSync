// Where the notebook column sits on screen and how far it can pan, given the controls drawn over
// it. Pure numbers in CSS px, so the editor and the tests share one model.
import type { RailDock } from "./rail-layout";
import { PAGE_WIDTH, type DeviceKind } from "./types";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const TOOLBAR_H = 56;
/** The iPad's floating tool rail: 12 px from the edge + 44 px buttons + padding and border, and a little air. */
export const RAIL_INSET = 76;
/** The Mac's docked tool sidebar. */
export const SIDEBAR_W = { expanded: 184, collapsed: 52 } as const;

export type ToolbarVariant = "rail" | "sidebar";
/** The iPad keeps its floating rail; the Mac docks its tools in a sidebar that can collapse. */
export const toolbarVariant = (kind: DeviceKind): ToolbarVariant => (kind === "ipad" ? "rail" : "sidebar");

export interface Insets { top: number; right: number; bottom: number; left: number }

export interface OverlayState {
  kind: DeviceKind;
  /** Mac sidebar expanded (ignored on the iPad, whose rail never changes size). */
  sidebarOpen: boolean;
  /** Width of the side panel (chat/notes) on the right, 0 when closed. */
  panelWidth: number;
  /** The screen edge the iPad rail is docked to (left unless moved in its settings). */
  railDock?: RailDock;
  /** The iPad's toolbar circles were all moved by hand and float over the page. */
  railFloating?: boolean;
  /** How wide a strip the iPad's docked toolbar takes (RAIL_INSET for the bar; circles vary). */
  railInset?: number;
}

/** The parts of the window covered by fixed controls: header, tool rail or sidebar, side panel. */
export function overlayInsets(o: OverlayState): Insets {
  const panel = Math.max(0, o.panelWidth);
  if (toolbarVariant(o.kind) === "sidebar") return { top: TOOLBAR_H, right: panel, bottom: 0, left: o.sidebarOpen ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed };
  if (o.railFloating) return { top: TOOLBAR_H, right: panel, bottom: 0, left: 0 };
  const dock = o.railDock ?? "left";
  const inset = o.railInset ?? RAIL_INSET;
  return {
    top: TOOLBAR_H,
    right: panel + (dock === "right" ? inset : 0),
    bottom: dock === "bottom" ? inset : 0,
    left: dock === "left" ? inset : 0,
  };
}

/** Air between the page and whatever covers the window around it. */
export const gutterFor = (kind: DeviceKind) => (kind === "ipad" ? 8 : 16);

/** Width of the unobstructed strip between the left and right controls. */
export const visibleWidth = (viewportW: number, insets: Insets) => Math.max(0, viewportW - insets.left - insets.right);

/** Zoom that fits the page across the visible strip, at most 100%. */
export function fitZoom(viewportW: number, insets: Insets, gutter: number, pageW: number) {
  return clampZoom(Math.min(1, (visibleWidth(viewportW, insets) - 2 * gutter) / pageW));
}

/**
 * Narrowest notebook strip the Mac keeps beside the side panel: the whole page at minimum zoom
 * plus its gutters, so the chat layout never hides the notebook.
 */
export const MIN_NOTEBOOK_VIEW = Math.ceil(PAGE_WIDTH * MIN_ZOOM) + 2 * gutterFor("desktop");

export interface ColumnLayout {
  /** Document x of the page's left edge. */
  left: number;
  /** Document width: the page, its gutters, and pan room past the controls on both sides. */
  contentWidth: number;
  /** Largest horizontal scroll. */
  maxScrollX: number;
}

/**
 * A page that fits the visible strip is centred in it and never pans sideways. A wider one gets
 * the inset plus a gutter on each side as scroll room, so scrolled fully left its left edge
 * clears the tools, and scrolled fully right its right edge clears the side panel.
 */
export function columnLayout(viewportW: number, pageW: number, insets: Insets, gutter: number): ColumnLayout {
  const avail = visibleWidth(viewportW, insets);
  if (pageW + 2 * gutter <= avail) {
    return { left: insets.left + (avail - pageW) / 2, contentWidth: viewportW, maxScrollX: 0 };
  }
  const left = insets.left + gutter;
  const contentWidth = Math.max(viewportW, left + pageW + gutter + insets.right);
  return { left, contentWidth, maxScrollX: contentWidth - viewportW };
}

/**
 * Space above the first section, and the least below the last. The editor uses
 * max(50vh, bottomMin): half a screen lets the last page's bottom edge rise to mid-screen, and a
 * CSS vh keeps it steady while iPad Safari's toolbar collapses and grows.
 */
export function verticalPadding(insets: Insets, gutter: number) {
  return { top: insets.top + gutter, bottomMin: insets.bottom + gutter, bottomShare: 0.5 };
}

/**
 * The scroll range (inclusive) over which document x `x` sits in the unobstructed strip, or null
 * when no scroll position shows it. Used by the tests to check nothing is trapped.
 */
export function revealRange(x: number, layout: ColumnLayout, viewportW: number, insets: Insets): [number, number] | null {
  // On screen at x - scrollX; it must land in [insets.left, viewportW - insets.right].
  const lo = Math.max(0, x - (viewportW - insets.right));
  const hi = Math.min(layout.maxScrollX, x - insets.left);
  return lo <= hi ? [lo, hi] : null;
}

/** The column and window at the start of a pinch, measured once. */
export interface PinchStart {
  zoom: number;
  /** Client position of the column's top-left corner, and the window scroll then. */
  left: number;
  top: number;
  scrollX: number;
  scrollY: number;
  /**
   * The notebook's own height then (top padding, column, bottom margin), not stretched to fill the
   * window, and the window height: a notebook shorter than the window can't scroll.
   */
  contentHeight: number;
  viewportH: number;
  /** How much of the column's height scales with zoom. */
  scaledHeight: number;
  /** Client point between the fingers when the pinch began. */
  anchor: [number, number];
  viewportW: number;
  insets: Insets;
  gutter: number;
}

export interface PinchPlacement {
  zoom: number;
  /** Window scroll after the commit. */
  scrollX: number;
  scrollY: number;
  /** Client position of the column's top-left corner after the commit. */
  left: number;
  top: number;
}

/**
 * Where a pinch at scale `s`, with its midpoint now at `mid`, leaves the page once committed: the
 * point first under the fingers moves to `mid`, as far as the scroll limits at the new zoom allow.
 * The live preview draws this same placement, so letting go never jumps.
 */
export function pinchPlacement(p: PinchStart, s: number, mid: [number, number]): PinchPlacement {
  const zoom = clampZoom(p.zoom * s);
  const k = zoom / p.zoom;
  const before = columnLayout(p.viewportW, PAGE_WIDTH * p.zoom, p.insets, p.gutter);
  const after = columnLayout(p.viewportW, PAGE_WIDTH * zoom, p.insets, p.gutter);
  // Document position of the column: centring can move it sideways; nothing above it scales.
  const docLeft = p.left + p.scrollX + after.left - before.left;
  const docTop = p.top + p.scrollY;
  const maxScrollY = Math.max(0, p.contentHeight + p.scaledHeight * (k - 1) - p.viewportH);
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const scrollX = clamp(docLeft + (p.anchor[0] - p.left) * k - mid[0], after.maxScrollX);
  const scrollY = clamp(docTop + (p.anchor[1] - p.top) * k - mid[1], maxScrollY);
  return { zoom, scrollX, scrollY, left: docLeft - scrollX, top: docTop - scrollY };
}
