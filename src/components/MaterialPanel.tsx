"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { pdfLecternLinks, type LecternLink } from "@/lib/lectern";
import { pdfPack, resolveRef, type Pack, type PackPage, type PackRef, type PackRefKind, type ResolvedRef } from "@/lib/pack";
import { pdfRaster } from "@/lib/pdf";
import type { PdfPage } from "@/lib/pdf-meta";
import { writePosition } from "@/lib/position";
import { PAGE_WIDTH, type SectionEntity } from "@/lib/types";
import { Icon } from "./Icons";

const GROUPS: { kind: PackRefKind; title: string }[] = [
  { kind: "answer", title: "Answers" },
  { kind: "taught", title: "The slide it practises" },
  { kind: "worked", title: "Worked in lessons" },
  { kind: "sheet", title: "Answer sheet" },
  { kind: "reading", title: "Related reading" },
];
const ROLE: Record<PackPage["role"], string> = { question: "Question", answer: "Answers", sheet: "Answer sheet", material: "Material" };

interface Props {
  notebookId: string;
  current: SectionEntity | null;
  sections: SectionEntity[];
  packMap: Map<string, PackPage>;
  visible: boolean;
  onJump: (sectionId: string) => void;
  /** Play a Lectern link in the Lecture tab. */
  onPlay: (path: string) => void;
}

/**
 * The Material tab: for a question page of an annotation pack, its lecture moments (the page's Lectern chips), its
 * answers, the lesson slides that work it, and related reading, each previewed here (the page's left half, where
 * the material is) with a link to the page. On any other page, the questions that point to it.
 */
export function MaterialPanel({ notebookId, current, sections, packMap, visible, onJump, onPlay }: Props) {
  const pdf = current?.data.pdf;
  const page = current ? packMap.get(current.id) : undefined;
  const key = pdf ? `${pdf.documentId}:${pdf.page}` : "";
  const [pack, setPack] = useState<{ id: string; pack: Pack | null } | null>(null);
  const [links, setLinks] = useState<{ key: string; links: LecternLink[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !pdf) return;
    let live = true;
    void pdfPack(pdf.documentId).then((p) => live && setPack({ id: pdf.documentId, pack: p }));
    pdfLecternLinks(pdf).then((l) => live && setLinks({ key: `${pdf.documentId}:${pdf.page}`, links: l }), () => {});
    return () => {
      live = false;
    };
  }, [visible, pdf]);

  const here = useMemo(
    () => (pack?.pack && pdf && pack.id === pdf.documentId ? { pack: pack.pack, sections, documentId: pdf.documentId } : null),
    [pack, pdf, sections],
  );

  if (!visible) return null;
  const moments = links?.key === key ? links.links : [];
  const material = page?.material ?? [];
  // on a page that isn't a question: the questions in this notebook whose material includes it
  const usedBy = here && page && page.role !== "question" && pdf
    ? sections.filter((s) => packMap.get(s.id)?.material?.some((m) => m.file === here.pack.file && m.page === pdf.page))
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!current || !pdf ? (
        <p className="p-4 text-slate-500">Material shows here for the pages of an imported annotation pack.</p>
      ) : (
        <>
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-semibold text-slate-800">{page?.title || current.data.title}</h2>
              {page && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${page.role === "question" ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600"}`}>{ROLE[page.role]}</span>}
            </div>
            {page?.chapter && <p className="mt-0.5 truncate text-xs text-slate-500">{page.chapter}</p>}
          </div>

          {moments.length > 0 && (
            <Group title="Lecture moments">
              {moments.map((l) => (
                <li key={l.path}>
                  <button type="button" onClick={() => onPlay(l.path)} className="flex w-full items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-left text-xs text-slate-800 ring-1 ring-amber-300 hover:bg-amber-100 pointer-coarse:py-2.5">
                    <span aria-hidden="true" className="text-amber-700">▶</span>
                    <span className="min-w-0 flex-1">{l.label}</span>
                  </button>
                </li>
              ))}
            </Group>
          )}

          {here && GROUPS.map(({ kind, title }) => {
            const refs = material.filter((m) => m.kind === kind);
            return refs.length ? (
              <Group key={kind} title={title}>
                {refs.map((r) => {
                  const id = `${kind}:${r.file}:${r.page}`;
                  return <RefItem key={id} refItem={r} here={here} notebookId={notebookId} open={open === id} onToggle={() => setOpen(open === id ? null : id)} onJump={onJump} />;
                })}
              </Group>
            ) : null;
          })}

          {usedBy.length > 0 && (
            <Group title="Questions that use this page">
              {usedBy.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onJump(s.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 pointer-coarse:py-2.5">
                    <span className="min-w-0 flex-1 truncate">{packMap.get(s.id)?.title}</span>
                    <Icon name="chevronRight" className="shrink-0 text-slate-400" />
                  </button>
                </li>
              ))}
            </Group>
          )}

          {pack?.id === pdf.documentId && !pack.pack && !moments.length && (
            <p className="p-4 text-slate-500">This PDF has no page map. Annotation packs built for padSync list each question&apos;s answers, worked slides and reading here.</p>
          )}
          {here && page?.role === "question" && !material.length && !moments.length && <p className="p-4 text-slate-500">No material is linked to this page.</p>}
          {here && page && page.role !== "question" && !usedBy.length && !moments.length && <p className="p-4 text-slate-500">No question in this notebook points to this page.</p>}
        </>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-200 p-2">
      <h3 className="px-1 pb-1 text-xs font-medium text-slate-500">{title}</h3>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

function RefItem({ refItem, here, notebookId, open, onToggle, onJump }: {
  refItem: PackRef;
  here: { pack: Pack; sections: SectionEntity[]; documentId: string };
  notebookId: string;
  open: boolean;
  onToggle: () => void;
  onJump: (sectionId: string) => void;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<ResolvedRef | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void resolveRef(refItem, here).then((t) => live && setTarget(t));
    return () => {
      live = false;
    };
  }, [refItem, here]);
  const elsewhere = target && target.notebookId !== notebookId;
  const go = () => {
    if (!target) return;
    if (!elsewhere) return onJump(target.section.id);
    writePosition(target.notebookId, { sectionId: target.section.id, offsetY: 0 });
    router.push(`/notebook?id=${encodeURIComponent(target.notebookId)}`);
  };
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        disabled={target === null}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent pointer-coarse:py-2.5"
      >
        <span className="min-w-0 flex-1">
          {refItem.label}
          {target === null && <span className="block text-[11px] text-slate-400">In “{refItem.file}”: import it to open this</span>}
          {elsewhere && <span className="block text-[11px] text-slate-400">In {refItem.file.replace(/\.pdf$/i, "")}</span>}
        </span>
        {target && <Icon name={open ? "chevronDown" : "chevronRight"} className="shrink-0 text-slate-400" />}
      </button>
      {open && target && (
        <div className="mt-1 space-y-1.5 px-1 pb-1">
          <button type="button" onClick={go} className="block w-full" title="Go to this page">
            <PagePreview pdf={target.pdf} />
          </button>
          <button type="button" onClick={go} className="btn btn-secondary btn-sm w-full">
            {elsewhere ? `Open in ${refItem.file.replace(/\.pdf$/i, "")}` : "Go to page"}
          </button>
        </div>
      )}
    </li>
  );
}

/** The left half of a pack page (where its material is), at the panel's width. */
function PagePreview({ pdf }: { pdf: PdfPage }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true, made = "";
    const stop = new AbortController();
    pdfRaster(pdf, undefined, stop.signal).then((blob) => {
      if (!live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, () => {});
    return () => {
      live = false;
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [pdf]);
  return (
    <div className="relative w-full overflow-hidden rounded-md bg-white ring-1 ring-slate-200" style={{ aspectRatio: `${PAGE_WIDTH / 2} / ${pdf.height}` }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="absolute left-0 top-0 h-full max-w-none" style={{ width: "200%" }} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">Loading page…</span>
      )}
    </div>
  );
}
