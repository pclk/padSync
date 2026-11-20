// Lectern is a lecture player that runs on the Mac (~/Repo/lectern, `npm start`) so recordings never leave it.
// Its annotation packs are PDFs with link chips like http://localhost:4747/watch/CS2030S/cs06?t=603&e=file-errors;
// imported into a notebook those links are rasterised away, so the Lecture tab reads them back from the PDF.
import { openPdf } from "./pdf";
import type { PdfPage } from "./pdf-meta";
import { useSetting } from "./settings";

export const LECTERN_URL_KEY = "padsync.lecternUrl";
/** On an iPad this is the Mac's address instead, e.g. http://my-mac.local:4747 with `npm run start:lan`. */
export const LECTERN_URL_DEFAULT = "http://localhost:4747";
const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/[^\s/]+/.test(v);
export const useLecternUrl = () => useSetting(LECTERN_URL_KEY, LECTERN_URL_DEFAULT, isUrl);

export interface LecternLink {
  /** /watch/<module>/<source>?t=..&e=.. */
  path: string;
  /** the chip's text, e.g. "▶ L04 slide 5 What can go wrong… Lecture 31-08 · 10:03" */
  label: string;
  /** top of the chip as a fraction of the page height, for ordering */
  top: number;
}

/** The player path of a Lectern link, whatever host it was written for, or null for any other link. */
export function lecternPath(url: string): string | null {
  try {
    const u = new URL(url);
    return /^\/watch\/[^/]+\/[^/]+$/.test(u.pathname) ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

export function lecternSrc(base: string, path: string) {
  const u = new URL(path, base);
  u.searchParams.set("embed", "1");
  return u.toString();
}

const links = new Map<string, Promise<LecternLink[]>>();

/** Lectern links on one PDF page, top to bottom (cached per page). */
export function pdfLecternLinks(page: Pick<PdfPage, "documentId" | "page">): Promise<LecternLink[]> {
  const key = `${page.documentId}:${page.page}`;
  let task = links.get(key);
  if (!task) {
    task = (async () => {
      const doc = await openPdf(page.documentId);
      const p = await doc.getPage(page.page);
      const [, , , height] = p.view;
      const [annotations, content] = await Promise.all([p.getAnnotations(), p.getTextContent()]);
      const text = content.items.flatMap((i) => ("str" in i && "transform" in i ? [{ s: i.str, x: i.transform[4] as number, y: i.transform[5] as number }] : []));
      return annotations.flatMap((a): LecternLink[] => {
        const path = a.subtype === "Link" && typeof a.url === "string" ? lecternPath(a.url) : null;
        if (!path) return [];
        const [x0, y0, x1, y1] = a.rect as number[];
        // the chip's own words, read back from the text under its rectangle
        const label = text.filter((t) => t.x >= x0 - 1 && t.x <= x1 && t.y >= y0 - 1 && t.y <= y1).map((t) => t.s).join(" ").replace(/\s+/g, " ").trim();
        return [{ path, label: label || path, top: 1 - y1 / height }];
      }).sort((a, b) => a.top - b.top);
    })();
    links.set(key, task);
    task.catch(() => links.delete(key));
  }
  return task;
}
