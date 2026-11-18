import { pdfImage } from "./pdf";
import { strokeBox, unionBox } from "@/ink/geometry";
import { paintStrokes } from "@/ink/render";
import { studyBlockMarkdown } from "./blocks";
import { db } from "./db";
import { liveChildren } from "./store";
import { PAGE_WIDTH, type SectionEntity, type StrokeEntity, type TextBoxEntity } from "./types";

export interface RenderOmit {
  /** Leave typed text boxes out of the image. */
  notes?: boolean;
  /** Leave images embedded in the printed content out of the image. */
  images?: boolean;
}

// Renders a section (content + typed text + ink) to a PNG, cropped to what is actually on it.
export async function sectionPng(section: SectionEntity, sectionEl: HTMLElement, scale = 2, omit: RenderOmit = {}): Promise<Blob> {
  const { toCanvas } = await import("html-to-image");
  const strokes = await liveChildren<StrokeEntity>(section.id, "stroke");
  const texts = omit.notes ? [] : await liveChildren<TextBoxEntity>(section.id, "textbox");
  const content = sectionEl.querySelector<HTMLElement>(".section-content");
  let contentBottom = 0;
  if (content) {
    // Ignore trailing blank answer space; it is only there to write in.
    const kids = [...content.children] as HTMLElement[];
    for (const k of kids) if (!k.dataset.space) contentBottom = Math.max(contentBottom, k.offsetTop + k.offsetHeight);
  }
  const inkBottom = unionBox(strokes.map(strokeBox))?.maxY ?? 0;
  const textBottom = texts.reduce((m, t) => Math.max(m, t.data.y + 60), 0);
  const height = Math.ceil(Math.min(sectionEl.offsetHeight, Math.max(section.data.pdf?.height ?? 0, contentBottom, inkBottom, textBottom) + 48));

  const canvas = await toCanvas(sectionEl, {
    width: PAGE_WIDTH,
    height,
    pixelRatio: scale,
    backgroundColor: section.data.pdf ? "transparent" : "#ffffff",
    style: { boxShadow: "none", ...(section.data.pdf ? { backgroundColor: "transparent" } : {}) },
    filter: (node) =>
      !(node instanceof HTMLCanvasElement) &&
      !(node instanceof HTMLElement && (node.hasAttribute("data-pdf-background") || node.classList.contains("ink-surface") || (omit.notes && node.dataset.textbox) || (omit.images && node.dataset.blockImage))),
  });
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(canvas.width / PAGE_WIDTH, 0, 0, canvas.width / PAGE_WIDTH, 0, 0);
  if (section.data.pdf) {
    // Composite under DOM text boxes and ink, even for a page outside the viewport.
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(await pdfImage(section.data.pdf,scale),0,0,PAGE_WIDTH,section.data.pdf.height);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0,0,PAGE_WIDTH,height);
    ctx.globalCompositeOperation = "source-over";
  }
  paintStrokes(ctx, strokes);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"));
}

export async function copySectionImage(section: SectionEntity, sectionEl: HTMLElement) {
  // Safari needs the ClipboardItem created synchronously inside the click, with a promise.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": sectionPng(section, sectionEl) })]);
}

export async function sectionSource(section: SectionEntity, includeSolution = false): Promise<string> {
  const d = section.data;
  const lines: string[] = [];
  const head = [d.title, d.marks != null ? `[${d.marks} marks]` : null].filter(Boolean).join(" ");
  if (d.pdf) lines.push(`PDF: ${d.pdf.name}, page ${d.pdf.page}`, d.pdf.text);
  if (head) lines.push(`## ${head}`);
  for (const b of d.blocks) {
    if (b.type === "markdown") lines.push(b.text);
    else if (b.type === "code") lines.push("```" + (b.language ?? "") + "\n" + b.code + "\n```");
    else if (b.type === "image") lines.push(b.src.startsWith("data:") ? `[image: ${b.alt ?? "figure"}]` : `![${b.alt ?? ""}](${b.src})`);
    else if (b.type === "divider") lines.push("---");
    else {
      const text = studyBlockMarkdown(b, includeSolution);
      if (text) lines.push(text);
    }
  }
  const texts = (await liveChildren<TextBoxEntity>(section.id, "textbox")).sort((a, b) => a.data.y - b.data.y);
  if (texts.length) lines.push("### My typed notes", ...texts.map((t) => t.data.text));
  if (includeSolution && d.solution) lines.push("### Reference solution (hidden from student)", d.solution);
  return lines.join("\n\n");
}

export interface SectionStats {
  strokes: number;
  erased: number;
  inkMs: number;
  spanMs: number;
  firstAt: number | null;
  focusEvents: number;
}

export async function sectionStats(sectionId: string): Promise<SectionStats> {
  const all = (await db.entities.where("[parentId+kind]").equals([sectionId, "stroke"]).toArray()) as StrokeEntity[];
  const live = all.filter((s) => !s.deleted);
  let inkMs = 0, first = Infinity, last = 0;
  for (const s of all) {
    const dur = s.data.pts[s.data.pts.length - 1] ?? 0;
    inkMs += dur;
    first = Math.min(first, s.data.t0);
    last = Math.max(last, s.data.t0 + dur);
  }
  const focusEvents = await db.events.where("[sectionId+type]").equals([sectionId, "focus"]).count();
  return {
    strokes: live.length,
    erased: all.length - live.length,
    inkMs,
    spanMs: all.length ? last - first : 0,
    firstAt: all.length ? first : null,
    focusEvents,
  };
}
