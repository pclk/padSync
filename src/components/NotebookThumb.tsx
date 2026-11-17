"use client";
import { useEffect, useRef, useState } from "react";
import { liveChildren, liveSections } from "@/lib/store";
import { pdfThumbnail } from "@/lib/pdf";
import { PAGE_WIDTH, type StrokeEntity } from "@/lib/types";
import { THUMB_HEIGHT, thumbnailStrokes, type ThumbStroke } from "@/lib/thumbnail";

interface Thumb {
  pdf: string | null;
  strokes: ThumbStroke[];
  /** The page is a PDF this device has no copy of yet; try again on the next visit. */
  partial?: boolean;
}

// Built thumbnails for this session, by notebook, tagged with the edit stamp they were built at,
// so returning to the library or re-sorting does not redo the work.
const built = new Map<string, { stamp: number; thumb: Thumb }>();

async function buildThumb(notebookId: string): Promise<Thumb> {
  const first = (await liveSections(notebookId))[0];
  if (!first) return { pdf: null, strokes: [] };
  const [strokes, pdf] = await Promise.all([
    liveChildren<StrokeEntity>(first.id, "stroke"),
    first.data.pdf ? pdfThumbnail(first.data.pdf) : null,
  ]);
  return { pdf, strokes: thumbnailStrokes(strokes), partial: !!first.data.pdf && !pdf };
}

/**
 * A card preview of the notebook's first page: PDF page 1 (if this device has the file) under
 * its ink. Work starts only once the card is near the viewport and is redone when `stamp` (the
 * last-edited time) moves. Empty notebooks keep the dot paper.
 */
export function NotebookThumb({ notebookId, stamp }: { notebookId: string; stamp: number | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState<Thumb | null>(() => built.get(notebookId)?.thumb ?? null);

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "200px 0px" });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || stamp === undefined) return;
    if (built.get(notebookId)?.stamp === stamp) return; // already in state from mount
    let active = true;
    buildThumb(notebookId).then((t) => {
      if (t.partial) built.delete(notebookId);
      else built.set(notebookId, { stamp, thumb: t });
      if (active) setThumb(t);
    }, () => {});
    return () => { active = false; };
  }, [visible, notebookId, stamp]);

  const empty = !thumb || (!thumb.pdf && !thumb.strokes.length);
  return (
    <div ref={ref} className="absolute inset-0 transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none" data-thumb={empty ? "empty" : "page"}>
      {empty ? (
        <div className="absolute inset-0 bg-[radial-gradient(#d5dbe5_1px,transparent_1px)] [background-size:14px_14px]" />
      ) : (
        <>
          {/* A local blob URL, rendered from this device's copy of the PDF. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {thumb.pdf && <img src={thumb.pdf} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />}
          {!!thumb.strokes.length && <ThumbInk strokes={thumb.strokes} />}
        </>
      )}
    </div>
  );
}

export function ThumbInk({ strokes }: { strokes: ThumbStroke[] }) {
  return (
    <svg viewBox={`0 0 ${PAGE_WIDTH} ${THUMB_HEIGHT}`} preserveAspectRatio="xMidYMin slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      {strokes.map((s) => (
        <path key={s.id} d={s.d} fill={s.color} style={s.highlighter ? { opacity: 0.32, mixBlendMode: "multiply" } : undefined} />
      ))}
    </svg>
  );
}
