import { PAGE_WIDTH } from "./types";

// How much a "this section" context covers: the section alone, it and a neighbour, or exactly
// what is on the screen (the iPad's when the chat follows it). Shared by the web's chat and the
// iPad app's prompts (ios/renderer/main.tsx), and a device setting so each keeps its own.

export type SectionSpan = "section" | "above" | "below" | "viewport";

export const SECTION_SPAN_KEY = "padsync.sectionSpan";

export const SECTION_SPANS: { v: SectionSpan; label: string }[] = [
  { v: "section", label: "Section" },
  { v: "above", label: "+ Above" },
  { v: "below", label: "+ Below" },
  { v: "viewport", label: "Screen" },
];

export const isSectionSpan = (v: unknown): v is SectionSpan => SECTION_SPANS.some((s) => s.v === v);

/** One section's visible part, in section-local page units (y down from its top). */
export interface ViewSlice {
  sectionId: string;
  y0: number;
  y1: number;
  /** The section's whole height, to say how far down the visible part is. */
  h?: number;
}

/** What a screen shows: the visible part of each section, top to bottom, and the visible width
 *  of the page (0 to PAGE_WIDTH when the whole width shows; narrower when zoomed in). */
export interface ScreenView {
  slices: ViewSlice[];
  x0: number;
  x1: number;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** A presence row's `view`, checked (it arrives from another device). */
export function readView(v: unknown): ScreenView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.slices) || !finite(o.x0) || !finite(o.x1)) return null;
  const slices = o.slices.filter(
    (s): s is ViewSlice => !!s && typeof s === "object" && typeof s.sectionId === "string" && finite(s.y0) && finite(s.y1) && s.y1 > s.y0,
  ).map((s) => ({ sectionId: s.sectionId, y0: s.y0, y1: s.y1, ...(finite(s.h) && s.h > 0 ? { h: s.h } : {}) }));
  return slices.length ? { slices, x0: Math.max(0, o.x0), x1: Math.min(PAGE_WIDTH, o.x1) } : null;
}

/** The view from on-screen rectangles of section elements (the web notebook, scrolled and zoomed),
 *  clipped to `clip`. A section's page units are its rectangle's width over PAGE_WIDTH. */
export function viewFromRects(rects: { id: string; rect: DOMRectReadOnly }[], clip: { top: number; bottom: number; left: number; right: number }): ScreenView | null {
  const slices: ViewSlice[] = [];
  let x0 = PAGE_WIDTH, x1 = 0;
  for (const { id, rect } of rects) {
    if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.width <= 0) continue;
    const scale = rect.width / PAGE_WIDTH;
    slices.push({ sectionId: id, y0: Math.round((Math.max(rect.top, clip.top) - rect.top) / scale), y1: Math.round((Math.min(rect.bottom, clip.bottom) - rect.top) / scale), h: Math.round(rect.height / scale) });
    x0 = Math.min(x0, Math.max(0, (clip.left - rect.left) / scale));
    x1 = Math.max(x1, Math.min(PAGE_WIDTH, (clip.right - rect.left) / scale));
  }
  return slices.length ? { slices, x0: Math.round(x0), x1: Math.round(x1) } : null;
}

/** The sections a span covers around `focusedId`, in notebook order. With no view to go by, the
 *  screen is just the focused section. */
export function spanSectionIds(sections: { id: string }[], focusedId: string, span: SectionSpan, view: ScreenView | null): string[] {
  const i = sections.findIndex((s) => s.id === focusedId);
  if (span === "viewport" && view) {
    const on = new Set(view.slices.map((s) => s.sectionId));
    const ids = sections.filter((s) => on.has(s.id)).map((s) => s.id);
    if (ids.length) return ids;
  }
  if (i < 0) return focusedId ? [focusedId] : [];
  if (span === "above") return sections.slice(Math.max(0, i - 1), i + 1).map((s) => s.id);
  if (span === "below") return sections.slice(i, i + 2).map((s) => s.id);
  return [focusedId];
}

/** The view kept to the sections in it that are being sent, or null for any other span. */
export function viewFor(span: SectionSpan, view: ScreenView | null, ids: string[]): ScreenView | null {
  if (span !== "viewport" || !view) return null;
  const slices = view.slices.filter((s) => ids.includes(s.sectionId));
  return slices.length ? { ...view, slices } : null;
}

/** A line for notebook.md saying what the screen shows. */
export function viewNote(view: ScreenView, numberOf: (id: string) => number): string {
  const pct = (n: number) => `${Math.round(Math.max(0, Math.min(100, n)))}%`;
  const parts = view.slices.map((s) => {
    const where = s.h ? `${pct((s.y0 / s.h) * 100)} to ${pct((s.y1 / s.h) * 100)} of the way down` : `y ${s.y0}–${s.y1}`;
    return `section ${numberOf(s.sectionId)} (${where})`;
  });
  const width = view.x1 - view.x0 < PAGE_WIDTH - 2 ? `, ${pct(((view.x1 - view.x0) / PAGE_WIDTH) * 100)} of the page width (zoomed in)` : "";
  return `_On my screen right now: ${parts.join(", ")}${width}. The renders show only that part; the text below covers each whole section._`;
}
