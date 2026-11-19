// The iPad tool rail's layout, chosen in its settings popover: which items it shows, in what
// order, and where on screen it docks. Pure data, so the editor (insets) and the rail share it.
import type { ToolKind } from "@/ink/controller";

export type RailItem = ToolKind | "colors" | "sizes" | "history" | "prompts";
/** The screen edge the rail sits against; "bottom" lays it out in a row. */
export type RailDock = "left" | "right" | "bottom";
/** Where along that edge: top/left, middle, bottom/right. */
export type RailAlign = "start" | "center" | "end";
/** A bar of buttons, or one circle you press and drag from to pick a tool. */
export type RailStyle = "bar" | "circle";

export interface RailLayout {
  order: RailItem[];
  hidden: RailItem[];
  dock: RailDock;
  align: RailAlign;
  style: RailStyle;
}

export const RAIL_ITEMS: readonly RailItem[] = ["pen", "highlighter", "eraser", "lasso", "text", "colors", "sizes", "history", "prompts"];
export const DEFAULT_RAIL: RailLayout = { order: [...RAIL_ITEMS], hidden: [], dock: "left", align: "center", style: "bar" };

const DOCKS: readonly RailDock[] = ["left", "right", "bottom"];
const ALIGNS: readonly RailAlign[] = ["start", "center", "end"];
const STYLES: readonly RailStyle[] = ["bar", "circle"];
const isItem = (v: unknown): v is RailItem => RAIL_ITEMS.includes(v as RailItem);

/** The pen is the one tool the rail always shows, so there is always something to draw with. */
export const canHide = (item: RailItem) => item !== "pen";

/**
 * A stored layout made whole: unknown or repeated items dropped, items it lacks (added in a later
 * version) appended in their default place, and a bad dock or alignment back to the default.
 */
export function normalizeRail(raw: Partial<RailLayout> | null | undefined): RailLayout {
  const order = [...new Set((Array.isArray(raw?.order) ? raw.order : []).filter(isItem))];
  for (const item of RAIL_ITEMS) if (!order.includes(item)) order.push(item);
  const hidden = [...new Set((Array.isArray(raw?.hidden) ? raw.hidden : []).filter(isItem))].filter(canHide);
  return {
    order,
    hidden,
    dock: DOCKS.includes(raw?.dock as RailDock) ? raw!.dock! : DEFAULT_RAIL.dock,
    align: ALIGNS.includes(raw?.align as RailAlign) ? raw!.align! : DEFAULT_RAIL.align,
    style: STYLES.includes(raw?.style as RailStyle) ? raw!.style! : DEFAULT_RAIL.style,
  };
}

/**
 * Moves an item one place up (-1) or down (+1) past the next item `among` accepts (all of them by
 * default; the circle's settings list only tools); no change at either end.
 */
export function moveItem(layout: RailLayout, item: RailItem, delta: -1 | 1, among: (i: RailItem) => boolean = () => true): RailLayout {
  const order = [...layout.order];
  const i = order.indexOf(item);
  let j = i + delta;
  while (j >= 0 && j < order.length && !among(order[j])) j += delta;
  if (i < 0 || j < 0 || j >= order.length) return layout;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...layout, order };
}

export function setHidden(layout: RailLayout, item: RailItem, hide: boolean): RailLayout {
  if (hide && !canHide(item)) return layout;
  const hidden = layout.hidden.filter((h) => h !== item);
  return { ...layout, hidden: hide ? [...hidden, item] : hidden };
}

export const visibleItems = (layout: RailLayout) => layout.order.filter((i) => !layout.hidden.includes(i));

export const isTool = (i: RailItem): i is ToolKind => !["colors", "sizes", "history", "prompts"].includes(i);
/** The tools the rail shows, in its order: the circle's fan. */
export const visibleTools = (layout: RailLayout) => visibleItems(layout).filter(isTool);
