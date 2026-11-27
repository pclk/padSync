import type { Block, SectionKind, SectionMargin, SpaceSize } from "./schema";

export type { Block, SectionKind, SectionMargin, SpaceSize };

// Shared data model. Everything that syncs is an Entity: a small JSON document with a
// hybrid-logical-clock stamp. Conflicts resolve per entity, last writer (highest hlc) wins.

/** The padSync payload version (see schema.ts). Kept here so code that only writes it doesn't load zod. */
export const SCHEMA_VERSION = 2;

export const PAGE_WIDTH = 1376; // iPad Pro 13" (M4) landscape width in CSS px
export const SCREEN_HEIGHT = 1032; // landscape height, used for default section sizes

export type EntityKind = "notebook" | "section" | "stroke" | "textbox" | "image" | "presence" | "folder";

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
  /** Set on notebooks made by AI import: the payload's hash, to warn before importing it twice. */
  source?: { importHash: string; importedAt: number; jobId?: string };
  /** The library folder it sits in; missing (or a folder that no longer exists) means the top level. */
  folderId?: string;
}

/** A library folder. Folders nest through folderId, like notebooks; notebookId is the folder's own id. */
export interface FolderData {
  name: string;
  createdAt: number;
  folderId?: string;
}

export type Template = "plain" | "dots" | "grid" | "lines";

/** Stable lecture references supplied by the parent provenance integration. */
export interface LectureSource {
  attachmentId: string;
  name?: string;
  pages?: number[];
}

export interface SectionData {
  pdf?: import("./pdf-meta").PdfPage;
  importApplication?: { key: string; title: string; appliedAt: number };
  sources?: LectureSource[];
  order: number;
  title?: string;
  blocks: Block[];
  /** Hidden from the writer, available to the AI for grading. Markdown + LaTeX. */
  solution?: string;
  timeLimitMinutes?: number;
  marks?: number;
  tags?: string[];
  template: Template;
  /** What the section is for (AI import); styles the header. */
  kind?: SectionKind;
  /** Learning goals, shown under the title. */
  objectives?: string[];
  /** A ruled column beside the content for handwritten annotations. */
  margin?: SectionMargin;
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
  /** Quick pen feel (0–1) kept by strokes drawn before `pen` existed (see strokePen). */
  smoothing?: number;
  sensitivity?: number;
  /** Pen parameters the stroke was drawn with that differ from the defaults (see pen-feel.ts). */
  pen?: Partial<Record<string, number | boolean | string>>;
  /** Drawn in the iPad app: the PencilKit stroke (base64), kept so the app gets it back exactly.
   *  Its `pts` are samples along PencilKit's already smooth curve (isNativeStroke). */
  pk?: string;
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

/** A picture placed on a page like ink, under it: section-local page units. `src` is a data: URL
 *  (src/lib/page-images.ts keeps it small enough to sync). */
export interface ImageData {
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
}

export interface PresenceData {
  device: string;
  deviceKind: DeviceKind;
  sectionId: string | null;
  /** Section-local y at the top of the viewport. */
  offsetY: number;
  /** What the screen shows (src/lib/section-span.ts); checked with readView before use. */
  view?: unknown;
  at: number;
}

export type DeviceKind = "ipad" | "desktop";


export const SPACE_PX: Record<SpaceSize, number> = { xs: 120, s: 240, m: 420, l: 640, xl: 900 };

export type NotebookEntity = Entity<"notebook", NotebookData>;
export type SectionEntity = Entity<"section", SectionData>;
export type StrokeEntity = Entity<"stroke", StrokeData>;
export type TextBoxEntity = Entity<"textbox", TextBoxData>;
export type ImageEntity = Entity<"image", ImageData>;
export type PresenceEntity = Entity<"presence", PresenceData>;
export type FolderEntity = Entity<"folder", FolderData>;

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
