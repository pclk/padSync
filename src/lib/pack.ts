// Annotation packs (from the Lectern/annotation-pack builder) embed a page map, padsync-pack.json: what each page is
// (a question, its answers, or reading material) and, for each question page, where its material is. padSync reads it
// from the PDF itself, so a notebook needs nothing extra stored or synced: the Material tab lists a question's
// material, and "Questions only" collapses every other page.
import { db } from "./db";
import { openPdf } from "./pdf";
import type { PdfPage } from "./pdf-meta";
import type { SectionEntity } from "./types";

export type PackRole = "question" | "answer" | "sheet" | "material";
export type PackRefKind = "answer" | "sheet" | "taught" | "worked" | "reading";

export interface PackRef {
  kind: PackRefKind;
  label: string;
  /** The import file the page is in (its name when imported), and the 1-based page in it. */
  file: string;
  page: number;
}

export interface PackPage {
  role: PackRole;
  title: string;
  doc: string;
  chapter: string;
  material?: PackRef[];
}

export interface Pack {
  format: "padsync.pack";
  version: 1;
  file: string;
  files: string[];
  pages: PackPage[];
}

export const PACK_ATTACHMENT = "padsync-pack.json";
const ROLES = new Set<PackRole>(["question", "answer", "sheet", "material"]);
const KINDS = new Set<PackRefKind>(["answer", "sheet", "taught", "worked", "reading"]);
const str = (v: unknown): v is string => typeof v === "string";

/** A page map from untrusted JSON, or null if it isn't one. Bad pages become plain material, bad refs are dropped. */
export function parsePack(data: unknown): Pack | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.format !== "padsync.pack" || d.version !== 1 || !str(d.file) || !Array.isArray(d.pages)) return null;
  const pages = d.pages.map((raw): PackPage => {
    const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const material = Array.isArray(p.material)
      ? p.material.filter((m): m is PackRef => !!m && typeof m === "object" && KINDS.has(m.kind) && str(m.label) && str(m.file) && Number.isInteger(m.page) && m.page > 0)
        .map(({ kind, label, file, page }) => ({ kind, label, file, page }))
      : undefined;
    return {
      role: ROLES.has(p.role as PackRole) ? (p.role as PackRole) : "material",
      title: str(p.title) ? p.title : "",
      doc: str(p.doc) ? p.doc : "",
      chapter: str(p.chapter) ? p.chapter : "",
      ...(material ? { material } : {}),
    };
  });
  return { format: "padsync.pack", version: 1, file: d.file, files: Array.isArray(d.files) ? d.files.filter(str) : [], pages };
}

const packs = new Map<string, Promise<Pack | null>>();

/** The page map embedded in a notebook's PDF, or null when it has none (cached per document). */
export function pdfPack(documentId: string): Promise<Pack | null> {
  let task = packs.get(documentId);
  if (!task) {
    task = (async () => {
      const doc = await openPdf(documentId);
      const attachments = await doc.getAttachments();
      for (const [id, a] of attachments ?? []) {
        if (a.filename !== PACK_ATTACHMENT) continue;
        const bytes = a.content ?? (await doc.getAttachmentContent(id));
        return bytes ? parsePack(JSON.parse(new TextDecoder().decode(bytes))) : null;
      }
      return null;
    })().catch(() => null);
    packs.set(documentId, task);
    // a PDF that couldn't be opened yet (still downloading elsewhere) gets another try
    void task.then((p) => { if (!p) packs.delete(documentId); });
  }
  return task;
}

/** Each PDF section's page in its document's page map, by section id. Sections without one aren't in the map. */
export async function packPages(sections: { id: string; documentId: string; page: number }[]): Promise<Map<string, PackPage>> {
  const out = new Map<string, PackPage>();
  const ids = [...new Set(sections.map((s) => s.documentId))];
  const byDoc = new Map(await Promise.all(ids.map(async (id) => [id, await pdfPack(id)] as const)));
  for (const s of sections) {
    const page = byDoc.get(s.documentId)?.pages[s.page - 1];
    if (page) out.set(s.id, page);
  }
  return out;
}

export type ColumnItem =
  | { type: "section"; section: SectionEntity; index: number }
  /** a run of pages hidden behind one bar */
  | { type: "collapsed"; key: string; sections: SectionEntity[]; count: number; label: string }
  /** the bar above a run that was opened, to hide it again */
  | { type: "opened"; key: string; count: number; label: string };

/**
 * The notebook column with "Questions only": each run of pages the page map says aren't questions becomes one
 * collapsed item, unless the run's key (its first section's id) is in `expanded`. Pages outside the map (blank pages
 * you added, other PDFs) always show.
 */
export function questionColumn(sections: SectionEntity[], pages: Map<string, PackPage>, expanded: ReadonlySet<string>): ColumnItem[] {
  const out: ColumnItem[] = [];
  let run: SectionEntity[] = [];
  const flush = () => {
    if (!run.length) return;
    const key = run[0].id, label = runLabel(run.map((s) => pages.get(s.id)!));
    if (expanded.has(key)) {
      out.push({ type: "opened", key, count: run.length, label });
      run.forEach((s) => out.push({ type: "section", section: s, index: sections.indexOf(s) }));
    } else out.push({ type: "collapsed", key, sections: run, count: run.length, label });
    run = [];
  };
  sections.forEach((s, index) => {
    const p = pages.get(s.id);
    if (p && p.role !== "question") run.push(s);
    else {
      flush();
      out.push({ type: "section", section: s, index });
    }
  });
  flush();
  return out;
}

/** "Slides L03, Problem Set 01 comments" for a run (first few documents, in order). */
export function runLabel(pages: PackPage[]): string {
  const docs = [...new Set(pages.map((p) => p.doc || p.chapter || "Cover"))];
  return docs.length > 3 ? `${docs.slice(0, 3).join(", ")} and ${docs.length - 3} more` : docs.join(", ");
}

/** The collapsed run holding a section, if any. */
export function runOf(items: ColumnItem[], sectionId: string): string | null {
  for (const it of items) if (it.type === "collapsed" && it.sections.some((s) => s.id === sectionId)) return it.key;
  return null;
}

export interface ResolvedRef {
  notebookId: string;
  section: SectionEntity;
  pdf: PdfPage;
}

const byFile = new Map<string, Promise<Map<number, SectionEntity>>>();

/**
 * Where a page-map reference lives: in this notebook when it names this notebook's own file (whatever it was called
 * on import), else in any notebook whose PDF was imported under that file name. Null if that file isn't imported.
 */
export async function resolveRef(ref: PackRef, here: { pack: Pack; sections: SectionEntity[]; documentId: string }): Promise<ResolvedRef | null> {
  if (ref.file === here.pack.file) {
    const s = here.sections.find((x) => x.data.pdf?.documentId === here.documentId && x.data.pdf.page === ref.page);
    return s?.data.pdf ? { notebookId: s.notebookId, section: s, pdf: s.data.pdf } : null;
  }
  let task = byFile.get(ref.file);
  if (!task) {
    task = (async () => {
      const rows = (await db.entities.where("kind").equals("section").filter((e) => !e.deleted && (e as SectionEntity).data.pdf?.name === ref.file).toArray()) as SectionEntity[];
      // only notebooks that still exist; if the file was imported twice, the newest notebook wins
      const books = await db.entities.bulkGet([...new Set(rows.map((r) => r.notebookId))]);
      const alive = new Map(books.flatMap((b) => (b && !b.deleted ? [[b.id, (b.data as { createdAt?: number }).createdAt ?? 0] as const] : [])));
      const map = new Map<number, SectionEntity>();
      for (const r of rows.filter((r) => alive.has(r.notebookId)).sort((x, y) => alive.get(x.notebookId)! - alive.get(y.notebookId)!)) map.set(r.data.pdf!.page, r);
      return map;
    })();
    byFile.set(ref.file, task);
    // a file imported later should be found: forget the lookup after a while
    setTimeout(() => byFile.delete(ref.file), 30_000);
  }
  const s = (await task).get(ref.page);
  return s?.data.pdf ? { notebookId: s.notebookId, section: s, pdf: s.data.pdf } : null;
}
