// Shared data model. Everything that syncs is an Entity: a small JSON document with a
// hybrid-logical-clock stamp. Conflicts resolve per entity, last writer (highest hlc) wins.

export const PAGE_WIDTH = 1376; // iPad Pro 13" (M4) landscape width in CSS px
export const SCREEN_HEIGHT = 1032; // landscape height, used for default section sizes

export type EntityKind = "notebook" | "section" | "stroke" | "textbox" | "presence";

export interface Entity<K extends EntityKind = EntityKind, D = unknown> {
  id: string;
  kind: K;
  notebookId: string;
  /** Section id for strokes/textboxes; empty otherwise. */
  parentId: string;
  data: D;
  hlc: string;
  /** 0/1 so Dexie can index it. Deleted entities are kept (soft delete) for analytics and undo. */
  deleted: 0 | 1;
  /** 1 while the local write has not been acknowledged by the server. */
  dirty: 0 | 1;
}

export interface NotebookData {
  title: string;
  description?: string;
  createdAt: number;
}

export type Template = "plain" | "dots" | "grid" | "lines";

export interface SectionData {
  order: number;
  title?: string;
  blocks: Block[];
  /** Hidden from the writer, available to the AI for grading. Markdown + LaTeX. */
  solution?: string;
  timeLimitMinutes?: number;
  marks?: number;
  tags?: string[];
  template: Template;
  minHeight: number;
  createdAt: number;
}

export type Tool = "pen" | "highlighter";

export interface StrokeData {
  tool: Tool;
  color: string;
  size: number;
  /** Flat array with stride STROKE_STRIDE: x, y, pressure, altitude, azimuth, t (ms since t0). */
  pts: number[];
  t0: number;
  /** "pen" | "mouse" — the input that produced the stroke. */
  input: string;
  device: string;
}

export const STROKE_STRIDE = 6;

export interface TextBoxData {
  x: number;
  y: number;
  w: number;
  text: string;
  fontSize: number;
  color: string;
}

export interface PresenceData {
  device: string;
  deviceKind: DeviceKind;
  sectionId: string | null;
  /** Section-local y at the top of the viewport. */
  offsetY: number;
  at: number;
}

export type DeviceKind = "ipad" | "desktop";

export type Block =
  | { type: "markdown"; text: string }
  | { type: "code"; language?: string; code: string }
  | { type: "image"; src: string; alt?: string; width?: number; caption?: string }
  | { type: "space"; size: SpaceSize | number }
  | { type: "divider" };

export type SpaceSize = "xs" | "s" | "m" | "l" | "xl";

export const SPACE_PX: Record<SpaceSize, number> = { xs: 120, s: 240, m: 420, l: 640, xl: 900 };

export type NotebookEntity = Entity<"notebook", NotebookData>;
export type SectionEntity = Entity<"section", SectionData>;
export type StrokeEntity = Entity<"stroke", StrokeData>;
export type TextBoxEntity = Entity<"textbox", TextBoxData>;
export type PresenceEntity = Entity<"presence", PresenceData>;

/** Append-only analytics log. Never updated, only inserted. */
export interface PadEvent {
  id: string;
  notebookId: string;
  sectionId: string | null;
  type: string;
  t: number;
  device: string;
  data: Record<string, unknown>;
  synced: 0 | 1;
}
