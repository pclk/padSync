import { attachmentPaths, type AttachmentMeta } from "./attachments";
import { contentHash, type BundleFile } from "./context";
import { GOALS, buildPrompt } from "./payload";
import { IMAGE_SRC_RE, parsePayloadText, type ParseResult, type Payload, type PayloadSection } from "./schema";
import { PART_CHARS, partsFor, type UploadSpec } from "./uploads";

// The AI import flow, minus the UI: attach → configure → send (bridge) or copy (chat) → review →
// import. Everything here is pure so the flow is tested without a browser.

export type Agent = "claude" | "codex";

export interface ImportConfig {
  request: string;
  goals: string[];
  agent: Agent;
  model?: string;
  effort?: string;
  webSearch?: boolean;
  allowCode?: boolean;
}

export const DEFAULT_CONFIG: ImportConfig = { request: "", goals: ["explain", "skeleton", "recall"], agent: "claude" };

export const PRESETS: { label: string; goals: string[]; request: string }[] = [
  { label: "Notes to write on", goals: ["skeleton", "margins", "recall", "glossary"], request: "Organise the attached lecture into notes I can annotate: follow its structure, blanks for the key facts, margins with prompts, and recall questions at the end of each topic." },
  { label: "Understand it", goals: ["explain", "map", "glossary"], request: "Help me understand the attached lecture: explain each key idea, work through the derivations step by step, and show how the ideas connect." },
  { label: "Practice set", goals: ["practice"], request: "8 practice problems on the attached lecture, increasing difficulty, with one recap section first." },
  { label: "Timed test", goals: ["test"], request: "A 30-minute timed test (4 questions) on the attached material, with marks and time limits per question." },
  { label: "Everything", goals: GOALS.map((g) => g.id).filter((g) => g !== "test"), request: "Turn the attached lecture into a complete study pack: organised notes with blanks and margins, explanations with worked examples, a concept map, recall questions, then practice problems." },
];

/** The small inline files every import job carries; lecture files go as uploads. */
export function importInlineFiles(c: Pick<ImportConfig, "request" | "goals">, attachments: Pick<AttachmentMeta, "name" | "mime" | "kind" | "persistentId" | "sourceFilename" | "selectedPages">[]): BundleFile[] {
  const paths = attachmentPaths(attachments);
  const request = [
    "# Request",
    "",
    c.request.trim() || "(no extra request: follow the goals)",
    "",
    "## Goals",
    ...(GOALS.filter((g) => c.goals.includes(g.id)).map((g) => `- ${g.label}`) as string[]),
    "",
    "## Attached files (in this order)",
    "Use only the selected pages where listed; otherwise use all pages. Cite the original filename and page numbers in section tags or captions. Create explanations, worked examples and handwritten note skeletons according to the goals, not only practice questions.",
    ...attachments.map((a, i) => `${i + 1}. \`${paths[i]}\`: ${a.name.replace(/[`\n\r]/g, "")} (${a.kind})${a.selectedPages?.length ? `; selected pages: ${a.selectedPages.join(", ")}` : ""}${a.persistentId ? `; attachment: ${a.persistentId}` : ""}`),
  ].join("\n");
  return [
    { path: "INSTRUCTIONS.md", mime: "text/markdown", text: buildPrompt({ request: c.request, goals: c.goals, files: attachments.map((a) => a.name), delivery: "file" }) + "\n" },
    { path: "request.md", mime: "text/markdown", text: request + "\n" },
  ];
}

/** The prompt to paste into a chat by hand when the bridge isn't available. */
export function chatPrompt(c: Pick<ImportConfig, "request" | "goals">, attachments: Pick<AttachmentMeta, "name" | "selectedPages" | "persistentId">[]) {
  return buildPrompt({ request: c.request, goals: c.goals, files: attachments.map((a) => a.name), delivery: "chat" }) + "\n\nSOURCE PAGES\nUse only selected pages where specified; otherwise all pages. Cite filenames and page numbers.\n" + attachments.map(a => `${a.name}: ${a.selectedPages?.length ? `selected pages: ${a.selectedPages.join(", ")}` : "all pages"}${a.persistentId ? `; attachment: ${a.persistentId}` : ""}`).join("\n");
}

export function uploadSpecs(items: { path: string; mime: string; base64: string }[]): UploadSpec[] {
  return items.map((i) => ({ path: i.path, mime: i.mime, size: i.base64.length, parts: partsFor(i.base64.length) }));
}

export function splitParts(base64: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += PART_CHARS) out.push(base64.slice(i, i + PART_CHARS));
  return out.length ? out : [""];
}

/** POST /api/jobs body for an import. */
export function importJobBody(c: ImportConfig, files: BundleFile[], uploads: UploadSpec[]) {
  return {
    kind: "import" as const,
    notebookId: "",
    sectionId: null,
    agent: c.agent,
    question: (c.request.trim() || "Make study material from the attached lecture notes, following the goals in request.md.").slice(0, 4000),
    context: "",
    image: null,
    files,
    uploads,
    options: {
      ...(c.model ? { model: c.model } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
      ...(c.webSearch ? { webSearch: true } : {}),
      allowEdits: true,
      ...(c.allowCode ? { allowCode: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The bridge's result

export interface ReturnedFile {
  path: string;
  mime: string;
  text?: string;
  base64?: string;
}

export interface PickedResult {
  text: string;
  /** Where the JSON came from, for the review header. */
  from: string;
}

/** out/padsync.json if the agent wrote it, else another JSON file with sections, else the answer text. */
export function pickResult(job: { output: string; resultFiles?: ReturnedFile[] }): PickedResult | null {
  const files = job.resultFiles ?? [];
  const named = files.find((f) => f.path.replace(/^out\//, "") === "padsync.json" && f.text);
  if (named) return { text: named.text!, from: "padsync.json" };
  const other = files.find((f) => f.path.endsWith(".json") && f.text && /"sections"\s*:/.test(f.text));
  if (other) return { text: other.text!, from: other.path };
  if (/"sections"\s*:/.test(job.output)) return { text: job.output, from: "the answer text" };
  return null;
}

/**
 * Parses and, for each valid section, resolves relative image sources (figures/…) against the
 * files the agent returned. A section with an image that can't be resolved becomes invalid
 * rather than importing with a broken image.
 */
export function reviewPayload(raw: string, returned: ReturnedFile[] = []): ParseResult {
  const r = parsePayloadText(raw);
  if (!r.payload) return r;
  const byPath = new Map(returned.map((f) => [f.path.replace(/^out\//, ""), f]));
  const sections = r.sections.map((rep) => {
    if (!rep.ok || !rep.section) return rep;
    const missing: string[] = [];
    const blocks = rep.section.blocks.map((b, bi) => {
      if (b.type !== "image" || IMAGE_SRC_RE.test(b.src)) return b;
      const f = byPath.get(b.src.replace(/^\.\//, "").replace(/^out\//, ""));
      if (f?.base64 && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)) return { ...b, src: `data:${f.mime};base64,${f.base64}` };
      missing.push(`sections[${rep.index}] ${JSON.stringify(rep.title)} › blocks[${bi}] (image) › src: ${JSON.stringify(b.src)} is not a file the AI returned${returned.length ? "" : " (use an https:// or data:image/ URL when pasting)"}`);
      return b;
    });
    return missing.length ? { ...rep, ok: false, errors: missing, section: undefined } : { ...rep, section: { ...rep.section, blocks } as PayloadSection };
  });
  const valid = sections.filter((s) => s.ok).map((s) => s.section!);
  // A payload means the head was valid, so every error belongs to a section.
  const errors = sections.flatMap((s) => s.errors);
  if (!valid.length) errors.unshift("No section could be imported.");
  return { ...r, ok: valid.length > 0, payload: valid.length ? { ...r.payload, sections: valid } : null, sections, errors };
}

/** The payload with only the ticked valid sections. */
export function selectSections(r: ParseResult, ticked: Set<number>): Payload | null {
  if (!r.payload) return null;
  const sections = r.sections.filter((s) => s.ok && ticked.has(s.index)).map((s) => s.section!);
  return sections.length ? { ...r.payload, sections } : null;
}

/** Identifies an import, so the same payload isn't imported twice by accident. */
export function payloadHash(p: Payload) {
  return contentHash(JSON.stringify(p));
}

// ---------------------------------------------------------------------------------------------
// Stage

export type JobStatus = "uploading" | "queued" | "running" | "done" | "error" | "cancelled";

export interface FlowState {
  attachments: number;
  /** Local upload in progress (before the server has every part). */
  sending: boolean;
  job: { status: JobStatus } | null;
  /** JSON text in the review box (from the bridge, a paste or a file). */
  raw: string;
  imported: boolean;
}

export type Stage = "attach" | "configure" | "sending" | "waiting" | "review" | "imported";

/** Which step is current; the page highlights it, but every step stays usable. */
export function stage(s: FlowState): Stage {
  if (s.imported) return "imported";
  if (s.sending || s.job?.status === "uploading") return "sending";
  if (s.job && (s.job.status === "queued" || s.job.status === "running")) return "waiting";
  if (s.raw.trim()) return "review";
  return s.attachments ? "configure" : "attach";
}
