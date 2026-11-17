import { DOCX_MIME, PPTX_MIME, slug, type BundleMime } from "./context";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_UPLOAD_FILES, base64Length } from "./uploads";

// Lecture notes attached on the AI import page. Pure helpers (no DOM, no IndexedDB): what a file
// is, the safe name it travels under, and whether the list fits the limits.

export type AttachmentKind = "pdf" | "image" | "text" | "slides" | "document";

export interface AttachmentMeta {
  id: string;
  /** The user's file name: shown, and listed in request.md, but never used as a path. */
  name: string;
  mime: BundleMime;
  kind: AttachmentKind;
  /** Bytes. */
  size: number;
}

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.bmp,.tif,.tiff,.md,.markdown,.txt,.tex,.csv,.json,.pptx,.docx,application/pdf,image/*,text/*";

const EXT: Record<string, { mime: BundleMime; kind: AttachmentKind }> = {
  pdf: { mime: "application/pdf", kind: "pdf" },
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  md: { mime: "text/markdown", kind: "text" },
  markdown: { mime: "text/markdown", kind: "text" },
  txt: { mime: "text/plain", kind: "text" },
  tex: { mime: "text/plain", kind: "text" },
  csv: { mime: "text/plain", kind: "text" },
  json: { mime: "application/json", kind: "text" },
  pptx: { mime: PPTX_MIME, kind: "slides" },
  docx: { mime: DOCX_MIME, kind: "document" },
};
/** Images the agents can't read directly; the browser converts them to JPEG first. */
const CONVERT = new Set(["heic", "heif", "bmp", "tif", "tiff", "avif"]);

const EXT_OF: Partial<Record<BundleMime, string>> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "text/markdown": "md", "text/plain": "txt", "application/json": "json", [PPTX_MIME]: "pptx", [DOCX_MIME]: "docx" };

export type Classified = { mime: BundleMime; kind: AttachmentKind; convert: boolean } | { error: string };

export function classify(name: string, type = ""): Classified {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (EXT[ext]) return { ...EXT[ext], convert: false };
  if (CONVERT.has(ext) || (type.startsWith("image/") && !EXT[ext])) return { mime: "image/jpeg", kind: "image", convert: true };
  if (type === "application/pdf") return { mime: "application/pdf", kind: "pdf", convert: false };
  if (type.startsWith("text/")) return { mime: "text/plain", kind: "text", convert: false };
  if (ext === "ppt" || ext === "key") return { error: `${name}: export it as PDF (or .pptx) first.` };
  if (ext === "doc" || ext === "pages") return { error: `${name}: export it as PDF (or .docx) first.` };
  return { error: `${name}: unsupported file type. Use PDF, images, text/Markdown, .pptx or .docx.` };
}

/** `lectures/NN-<ascii slug>.<ext>`: a valid bundle path whatever the user's file was called. */
export function safePath(name: string, index: number, mime: BundleMime) {
  const base = name.replace(/\.[A-Za-z0-9]{1,10}$/, "");
  return `lectures/${String(index + 1).padStart(2, "0")}-${slug(base, "file")}.${EXT_OF[mime] ?? "bin"}`;
}

export function attachmentPaths(list: Pick<AttachmentMeta, "name" | "mime">[]) {
  return list.map((a, i) => safePath(a.name, i, a.mime));
}

export function formatBytes(n: number) {
  return n < 1000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`;
}

/** Problems that block sending: too many files, a file or the total too large. */
export function checkLimits(list: Pick<AttachmentMeta, "name" | "size">[]): string[] {
  const out: string[] = [];
  if (list.length > MAX_UPLOAD_FILES) out.push(`At most ${MAX_UPLOAD_FILES} files per import (you have ${list.length}).`);
  for (const a of list) if (a.size > MAX_FILE_BYTES) out.push(`${a.name} is ${formatBytes(a.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file. Split it or export fewer pages.`);
  const total = list.reduce((n, a) => n + a.size, 0);
  if (total > MAX_TOTAL_BYTES) out.push(`The files add up to ${formatBytes(total)}; the limit is ${formatBytes(MAX_TOTAL_BYTES)} per import.`);
  return out;
}

export const totalUploadChars = (list: Pick<AttachmentMeta, "size">[]) => list.reduce((n, a) => n + base64Length(a.size), 0);

/** Moves one item; out-of-range indexes leave the list as it is. */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Office files need the agent to run a command (unzip); Claude only may with "allow code". */
export const needsCode = (list: Pick<AttachmentMeta, "kind">[]) => list.some((a) => a.kind === "slides" || a.kind === "document");
