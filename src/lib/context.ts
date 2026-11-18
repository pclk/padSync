import { maskAnswers, studyBlockMarkdown } from "./blocks";
import { SCHEMA_VERSION, type Block, type SectionData } from "./types";

// What "Ask AI" sends: a small folder of files (the bundle) that the Mac bridge writes into the
// job's temp dir. Nothing here touches the DOM or the database, so the preview, the send and the
// tests all go through the same pure builder. See docs/context-control-2026-11-17.md.

export type ContextScope = "all" | "sections" | "selection";

export interface ContextOptions {
  scope: ContextScope;
  /** Sections ticked in the list; only used when scope is "sections". */
  sectionIds: string[];
  /** Keep only sections with activity within RECENT_MS. */
  recentOnly: boolean;
  renders: boolean;
  notes: boolean;
  solutions: boolean;
  images: boolean;
  /** The agent may write changed copies into out/. */
  allowEdits: boolean;
  /** Claude also gets Bash (sandboxed). */
  allowCode: boolean;
}

export const DEFAULT_CONTEXT: ContextOptions = {
  scope: "all",
  sectionIds: [],
  recentOnly: false,
  renders: true,
  notes: true,
  solutions: true,
  images: true,
  allowEdits: true,
  allowCode: false,
};

export const RECENT_MS = 24 * 60 * 60_000;
/** Total payload chars (text JSON-escaped, binaries base64). Below Vercel's 4.5 MB body limit. */
export const MAX_BUNDLE_BYTES = 3_200_000;
export const MAX_BUNDLE_FILES = 64;
/** One optional folder, then a name; no leading dot, so no `..` and no hidden files. */
export const BUNDLE_PATH_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const BUNDLE_MIMES = ["text/markdown", "text/plain", "application/json", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", PPTX_MIME, DOCX_MIME] as const;
export type BundleMime = (typeof BUNDLE_MIMES)[number];
/** Binary files travel as base64, the rest as text. */
export const isBinaryMime = (m: string) => m.startsWith("image/") || m === "application/pdf" || m === PPTX_MIME || m === DOCX_MIME;

export interface Raster {
  base64: string;
  width: number;
  height: number;
}

export interface SectionInput {
  id: string;
  data: SectionData;
  /** Typed text boxes, top to bottom. */
  notes: string[];
  /** Latest write to the section, its ink or its text (ms). */
  lastActivity: number;
  /** Full revision of the section and its ink/text (hlc strings, counts); for signatures only. */
  revision?: string;
  render?: Raster | null;
  /** Why there is no render, when it was left out on purpose. */
  renderNote?: string;
}

export interface SelectionInput {
  sectionId: string;
  /** Highlighted text. */
  text?: string;
  /** Render cropped to the lasso box. */
  crop?: Raster | null;
}

export interface BundleFile {
  path: string;
  mime: BundleMime;
  text?: string;
  base64?: string;
}

export interface Bundle {
  files: BundleFile[];
  /** Sections that made it in, in notebook order. */
  sectionIds: string[];
  /** Human-readable notes on what was left out for size. */
  skipped: string[];
  bytes: number;
  tokens: number;
  error?: string;
}

export interface BundleInput {
  title: string;
  /** Every live section of the notebook, in order (numbering follows the notebook). */
  sections: SectionInput[];
  selection?: SelectionInput | null;
  now?: number;
  maxBytes?: number;
}

export function hasSelection(s: SelectionInput | null | undefined): s is SelectionInput {
  return !!s && (!!s.text?.trim() || !!s.crop);
}

/** The sections the options pick, in notebook order. */
export function pickSections(sections: SectionInput[], o: ContextOptions, selection?: SelectionInput | null, now = Date.now()): SectionInput[] {
  let picked: SectionInput[];
  if (o.scope === "selection") picked = hasSelection(selection) ? sections.filter((s) => s.id === selection.sectionId) : [];
  else if (o.scope === "sections") {
    const ids = new Set(o.sectionIds);
    picked = sections.filter((s) => ids.has(s.id));
  } else picked = sections;
  if (o.recentOnly && o.scope !== "selection") picked = picked.filter((s) => now - s.lastActivity <= RECENT_MS);
  return picked;
}

export function slug(s: string | undefined, fallback = "section") {
  const out = (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return out || fallback;
}

const IMAGE_EXT: Record<string, BundleMime> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** 53-bit string hash (cyrb53): synchronous, so the browser and tests agree without crypto.subtle. */
export function contentHash(str: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Every image block gets a reference named by section id and a hash of its src. Embedded
 * (`data:`) images are written under that path; remote ones only use it when images are excluded,
 * so the URL itself isn't shared. A returned notebook.json that still points at a reference maps
 * back to exactly that image, and to nothing if the image was replaced meanwhile.
 */
export function imageRef(sectionId: string, src: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(sectionId)) return null;
  const m = /^data:image\/(png|jpeg|gif|webp);base64,/.exec(src);
  if (m) return `assets/${sectionId}-${contentHash(src)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  if (src.startsWith("https:")) return `assets/${sectionId}-${contentHash(src)}.url`;
  return null;
}

/** The path an embedded image is written to, or null when it is not a file (remote, svg, …). */
export function assetPath(sectionId: string, src: string): string | null {
  const p = imageRef(sectionId, src);
  return p && !p.endsWith(".url") ? p : null;
}

/** Every image reference the current notebook could have exported, with its src. */
export function assetMap(sections: Pick<SectionInput, "id" | "data">[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sections)
    for (const b of s.data.blocks) {
      if (b.type !== "image") continue;
      const p = imageRef(s.id, b.src);
      if (p) map.set(p, b.src);
    }
  return map;
}

export function renderPath(index: number, title: string | undefined) {
  return `renders/${String(index + 1).padStart(2, "0")}-${slug(title)}.png`;
}

const utf8 = new TextEncoder();
/** Payload cost of a file as it travels in the job JSON. */
export function fileBytes(f: BundleFile) {
  return f.base64 != null ? f.base64.length : utf8.encode(JSON.stringify(f.text ?? "")).length;
}

export function imageTokens(r: Pick<Raster, "width" | "height">) {
  return Math.min(1600, Math.ceil((r.width * r.height) / 750));
}

function sectionHeading(index: number, d: SectionData) {
  const marks = d.marks != null ? ` [${d.marks} marks]` : "";
  return `## ${index + 1}. ${d.title?.trim() || "Untitled"}${marks}`;
}

function blockMarkdown(b: Block, assetRef: string | null, imagesIncluded: boolean, answers: boolean): string | null {
  if (b.type === "markdown") return b.text;
  if (b.type === "code") return "```" + (b.language ?? "") + "\n" + b.code + "\n```";
  if (b.type === "divider") return "---";
  if (b.type === "image") {
    const cap = b.caption ? `\n\n_${b.caption}_` : "";
    if (!imagesIncluded) return `[image: ${b.alt || "figure"}]${cap}`;
    if (!b.src.startsWith("data:")) return `![${b.alt ?? ""}](${b.src})${cap}`;
    if (assetRef) return `![${b.alt ?? ""}](${assetRef})${cap}`;
    return `[image: ${b.alt || "figure"}${imagesIncluded ? " (not included: size limit)" : ""}]${cap}`;
  }
  return studyBlockMarkdown(b, answers); // null for answer space
}

/** Builds the bundle for the given options. Same input, same output: the preview is the send. */
export function buildBundle(input: BundleInput, o: ContextOptions): Bundle {
  const maxBytes = input.maxBytes ?? MAX_BUNDLE_BYTES;
  const indexOf = new Map(input.sections.map((s, i) => [s.id, i]));
  const picked = pickSections(input.sections, o, input.selection, input.now);
  const empty = (error: string): Bundle => ({ files: [], sectionIds: [], skipped: [], bytes: 0, tokens: 0, error });
  if (o.scope === "selection" && !hasSelection(input.selection)) return empty("Nothing is selected. Highlight text or lasso ink in a section first.");
  if (!picked.length) return empty(o.recentOnly ? "No chosen section changed in the last 24 hours." : "No sections are chosen.");

  // Binary candidates, most important first; whatever overflows the budget is dropped from the end.
  const binaries: { file: BundleFile; tokens: number; label: string }[] = [];
  const sel = o.scope === "selection" ? input.selection! : null;
  if (sel?.crop) binaries.push({ file: { path: "selection.png", mime: "image/png", base64: sel.crop.base64 }, tokens: imageTokens(sel.crop), label: "the selection image" });
  if (!sel) {
    if (o.images)
      for (const s of picked)
        for (const b of s.data.blocks) {
          const p = b.type === "image" ? assetPath(s.id, b.src) : null;
          // The same image twice in a section is one file (paths must be unique).
          if (!p || b.type !== "image" || binaries.some((x) => x.file.path === p)) continue;
          const mime = IMAGE_EXT[/^data:image\/(\w+)/.exec(b.src)![1]];
          binaries.push({ file: { path: p, mime, base64: b.src.slice(b.src.indexOf(",") + 1) }, tokens: 800, label: `image in section ${indexOf.get(s.id)! + 1}` });
        }
    if (o.renders)
      for (const s of picked)
        if (s.render) binaries.push({ file: { path: renderPath(indexOf.get(s.id)!, s.data.title), mime: "image/png", base64: s.render.base64 }, tokens: imageTokens(s.render), label: `render of section ${indexOf.get(s.id)! + 1}` });
  }

  const textFiles = (kept: Set<string>) => (sel ? selectionText(input, sel, o, kept, indexOf) : notebookText(input, picked, o, kept, indexOf));
  const all = new Set(binaries.map((b) => b.file.path));
  // Text is sized with every reference in place; dropping a reference only shortens it, and the
  // margin covers the "(not included)" notes that replace dropped images.
  const textCost = textFiles(all).reduce((n, f) => n + fileBytes(f), 0) + 4096;
  if (textCost > maxBytes) return empty(`The text alone is ${kb(textCost)}, over the ${kb(maxBytes)} limit. Choose fewer sections.`);

  let used = textCost;
  const kept = new Set<string>();
  const skipped: string[] = [];
  for (const b of binaries) {
    const cost = fileBytes(b.file);
    if (used + cost <= maxBytes && kept.size + 4 < MAX_BUNDLE_FILES) {
      used += cost;
      kept.add(b.file.path);
    } else skipped.push(`${b.label} (size limit)`);
  }
  // A selection that is only an image must not go out as an empty shell.
  if (sel && !sel.text?.trim() && !kept.has("selection.png")) return empty(`The selected area is too large to send (over ${kb(maxBytes)}). Lasso a smaller area.`);
  for (const s of picked) if (o.renders && !sel && !s.render) skipped.push(`render of section ${indexOf.get(s.id)! + 1} (${s.renderNote ?? "not on screen"})`);

  const files = [...textFiles(kept), ...binaries.filter((b) => kept.has(b.file.path)).map((b) => b.file)];
  const textChars = files.reduce((n, f) => n + (f.text?.length ?? 0), 0);
  const tokens = Math.ceil(textChars / 4) + binaries.filter((b) => kept.has(b.file.path)).reduce((n, b) => n + b.tokens, 0);
  return { files, sectionIds: picked.map((s) => s.id), skipped, bytes: files.reduce((n, f) => n + fileBytes(f), 0), tokens };
}

function notebookText(input: BundleInput, picked: SectionInput[], o: ContextOptions, kept: Set<string>, indexOf: Map<string, number>): BundleFile[] {
  const md: string[] = [`# ${input.title.trim() || "Untitled notebook"}`];
  md.push(`_Exported from padSync: ${picked.length} of ${input.sections.length} section${input.sections.length === 1 ? "" : "s"}._`);
  const json = {
    schemaVersion: SCHEMA_VERSION,
    title: input.title,
    sections: [] as Record<string, unknown>[],
  };
  for (const s of picked) {
    const i = indexOf.get(s.id)!;
    const d = s.data;
    md.push(sectionHeading(i, d));
    if (d.pdf) md.push(`PDF: ${d.pdf.name} · page ${d.pdf.page}`, d.pdf.text);
    const meta = [`id: ${s.id}`, d.tags?.length ? `tags: ${d.tags.join(", ")}` : null, d.timeLimitMinutes ? `time limit: ${d.timeLimitMinutes} min` : null].filter(Boolean);
    md.push(`<!-- ${meta.join(" · ")} -->`);
    const render = renderPath(i, d.title);
    if (kept.has(render)) md.push(`![Render of section ${i + 1}: the printed content plus my handwriting](${render})`);
    for (const b of d.blocks) {
      const p = b.type === "image" ? assetPath(s.id, b.src) : null;
      const text = blockMarkdown(b, p && kept.has(p) ? p : null, o.images, o.solutions);
      if (text != null && text.trim()) md.push(text);
    }
    if (o.notes && s.notes.some((n) => n.trim())) md.push("### My typed notes", ...s.notes.filter((n) => n.trim()));
    if (o.solutions && d.solution) md.push("### Reference solution (hidden from student)", d.solution);

    const blocks = d.blocks.map((b) => {
      // Without solutions, hidden answers are blanked too (the return path maps them back).
      if (b.type !== "image") return o.solutions ? b : maskAnswers(b);
      // Embedded images always travel as their reference (mapped back on return, keeps the JSON
      // small); remote URLs only when images are included.
      const ref = imageRef(s.id, b.src);
      return ref && (b.src.startsWith("data:") || !o.images) ? { ...b, src: ref } : b;
    });
    json.sections.push({
      id: s.id,
      ...(d.title != null ? { title: d.title } : {}),
      blocks,
      ...(o.solutions && d.solution ? { solution: d.solution } : {}),
      ...(d.marks != null ? { marks: d.marks } : {}),
      ...(d.timeLimitMinutes != null ? { timeLimitMinutes: d.timeLimitMinutes } : {}),
      ...(d.tags?.length ? { tags: d.tags } : {}),
      template: d.template,
      ...(d.kind ? { kind: d.kind } : {}),
      ...(d.objectives?.length ? { objectives: d.objectives } : {}),
      ...(d.margin ? { margin: d.margin } : {}),
    });
  }
  return [
    { path: "README.md", mime: "text/markdown", text: readme(o, false) },
    { path: "notebook.md", mime: "text/markdown", text: md.join("\n\n") + "\n" },
    { path: "notebook.json", mime: "application/json", text: JSON.stringify(json, null, 2) + "\n" },
  ];
}

function selectionText(input: BundleInput, sel: SelectionInput, o: ContextOptions, kept: Set<string>, indexOf: Map<string, number>): BundleFile[] {
  const i = indexOf.get(sel.sectionId) ?? 0;
  const sec = input.sections[i];
  const md = [`# Selection from section ${i + 1}: ${sec?.data.title?.trim() || "Untitled"}`, `_Notebook: ${input.title.trim() || "Untitled notebook"}. Only this selection was shared._`];
  if (sec?.data.pdf) md.push(`PDF: ${sec.data.pdf.name} · page ${sec.data.pdf.page}`);
  if (kept.has("selection.png")) md.push("![The selected area, with my handwriting](selection.png)");
  if (sel.text?.trim()) md.push("## Selected text", sel.text.trim());
  return [
    { path: "README.md", mime: "text/markdown", text: readme(o, true) },
    { path: "selection.md", mime: "text/markdown", text: md.join("\n\n") + "\n" },
  ];
}

function readme(o: ContextOptions, selection: boolean) {
  const lines = [
    "# padSync export",
    "",
    "Files in this folder:",
    selection
      ? "- `selection.md`: only the part of the notebook I selected (and `selection.png`, the selected area, if present)."
      : [
          "- `notebook.md`: the chosen sections in order: printed content (Markdown + LaTeX), my typed notes" + (o.solutions ? ", and reference solutions I have NOT seen" : "") + ".",
          "- `notebook.json`: the same sections in padSync's import format. Each section keeps its `id`.",
          o.renders ? "- `renders/`: one image per section showing the printed content plus my handwriting. Handwriting exists only in these images." : null,
          o.images ? "- `assets/`: images embedded in the sections." : null,
        ]
          .filter(Boolean)
          .join("\n"),
  ];
  if (o.allowEdits) {
    lines.push(
      "",
      "Returning changes:",
      "- Do not edit these files in place. Write changed copies into `out/` under the same relative path.",
      selection
        ? "- For a rewritten selection, write `out/selection.md`."
        : "- To change notebook content, write `out/notebook.json` in the same format. Keep each section's `id`; leave `id` out for new sections; omit a field to leave it unchanged. Handwriting cannot be changed.",
      "- Anything else you produce (worked solutions, summaries, scripts) can also go in `out/`.",
    );
  }
  return lines.join("\n") + "\n";
}

export function kb(bytes: number) {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Changes whenever anything the bundle depends on changes: any write to a section, its ink or its
 * text gets a new hlc (full string, not just its millisecond), so a previewed bundle is only sent
 * while it is still current.
 */
export function bundleSignature(title: string, sections: Pick<SectionInput, "id" | "lastActivity" | "revision">[], selectionKey: unknown, o: ContextOptions) {
  return JSON.stringify([title, sections.map((s) => [s.id, s.revision ?? s.lastActivity]), selectionKey ?? null, o]);
}

export interface AskRequest {
  notebookId: string;
  sectionId: string | null;
  agent: "claude" | "codex";
  question: string;
  options: { model?: string; effort?: string; webSearch?: boolean };
}

/** The POST /api/jobs body: the bundle's files as built (and previewed), nothing re-derived. */
export function jobRequestBody(r: AskRequest, bundle: Bundle, o: ContextOptions) {
  return {
    notebookId: r.notebookId,
    sectionId: r.sectionId,
    agent: r.agent,
    question: r.question,
    context: "",
    image: null,
    files: bundle.files,
    options: {
      ...(r.options.model ? { model: r.options.model } : {}),
      ...(r.options.effort ? { effort: r.options.effort } : {}),
      ...(r.options.webSearch ? { webSearch: true } : {}),
      ...(o.allowEdits ? { allowEdits: true } : {}),
      ...(o.allowEdits && o.allowCode ? { allowCode: true } : {}),
    },
  };
}
