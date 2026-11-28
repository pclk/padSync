import { MIN_NOTEBOOK_VIEW } from "@/lib/notebook-viewport";

/** Web notebook layout: drawing hides the side panel, half splits 50/50, chat gives the page 25%. */
export type LayoutMode = "drawing" | "half" | "chat";
export const LAYOUT_MODES: readonly LayoutMode[] = ["drawing", "half", "chat"];
export const isLayoutMode = (v: unknown): v is LayoutMode => LAYOUT_MODES.includes(v as LayoutMode);
// Share of the window the side panel takes in each mode.
const PANEL_SHARE: Record<LayoutMode, number> = { drawing: 0, half: 0.5, chat: 0.75 };
// Below this the panel stops giving way to the notebook; a window that narrow pans instead.
const MIN_PANEL = 320;
/**
 * The panel's share, but never so wide that less than MIN_NOTEBOOK_VIEW of notebook is left
 * beside it once the tool sidebar (leftInset) has taken its part.
 */
export function panelWidth(mode: LayoutMode, viewportWidth: number, leftInset = 0) {
  const share = Math.round(viewportWidth * PANEL_SHARE[mode]);
  if (!share) return 0;
  const room = viewportWidth - leftInset - MIN_NOTEBOOK_VIEW;
  return Math.max(0, Math.min(share, Math.max(room, Math.min(share, MIN_PANEL))));
}
