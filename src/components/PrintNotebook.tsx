"use client";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { strokeBox, unionBox } from "@/ink/geometry";
import { renderMarkdown } from "@/lib/markdown";
import { buildPdf, sectionPages, type PdfPage } from "@/lib/pdf-export";
import { liveChildren, liveSections } from "@/lib/store";
import { PAGE_WIDTH, type ImageEntity, type SectionEntity, type StrokeEntity, type TextBoxEntity } from "@/lib/types";
import { Blocks, MarginColumn, SectionHeader } from "./SectionContent";

// A read-only copy of SectionView's page markup, so notebooks that are not open can be exported.
// Ink and PDF pages are painted by sectionPng from the database, so they are left out here.
function PrintSection({ section, index, minHeight, texts, images }: { section: SectionEntity; index: number; minHeight: number; texts: TextBoxEntity[]; images: ImageEntity[] }) {
  const margin = section.data.margin;
  const marginPx = margin ? Math.round(PAGE_WIDTH * (margin.width ?? 0.3)) : 0;
  return (
    <section data-section-id={section.id} className={`paper template-${section.data.template} relative bg-white`} style={{ width: PAGE_WIDTH, minHeight }}>
      {margin && <MarginColumn margin={margin} width={marginPx} />}
      <div className="section-content relative px-14 pt-8 pb-6" style={{ marginLeft: margin?.side === "left" ? marginPx : 0, marginRight: margin && margin.side !== "left" ? marginPx : 0 }}>
        {!section.data.pdf && <SectionHeader section={section} index={index} />}
        <Blocks blocks={section.data.blocks} />
      </div>
      {images.map((im) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={im.id} src={im.data.src} alt="" className="absolute" style={{ left: im.data.x, top: im.data.y, width: im.data.w, height: im.data.h }} />
      ))}
      {texts.map((tb) => (
        <div
          key={tb.id}
          data-textbox="1"
          className="textbox absolute z-10 rounded p-1 leading-snug"
          style={{ left: tb.data.x, top: tb.data.y, width: tb.data.w, fontSize: tb.data.fontSize, color: tb.data.color }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(tb.data.text) }}
        />
      ))}
    </section>
  );
}

/** Renders the notebooks off screen, one at a time, into a single PDF in the given order. */
export async function notebooksPdf(notebookIds: string[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${PAGE_WIDTH}px;pointer-events:none`;
  document.body.appendChild(host);
  const root = createRoot(host);
  const parts: PdfPage[] = [];
  try {
    for (const [n, id] of notebookIds.entries()) {
      const sections = await liveSections(id);
      if (!sections.length) continue;
      const pages = await Promise.all(
        sections.map(async (s) => {
          const strokes = await liveChildren<StrokeEntity>(s.id, "stroke");
          const texts = await liveChildren<TextBoxEntity>(s.id, "textbox");
          const inkBottom = unionBox(strokes.map(strokeBox))?.maxY ?? 0;
          const textBottom = texts.reduce((m, t) => Math.max(m, t.data.y + 200), 0);
          const images = await liveChildren<ImageEntity>(s.id, "image");
          const imageBottom = images.reduce((m, t) => Math.max(m, t.data.y + t.data.h + 48), 0);
          return { s, texts, images, minHeight: Math.ceil(Math.max(s.data.minHeight, s.data.pdf?.height ?? 0, inkBottom + 48, textBottom, imageBottom)) };
        }),
      );
      flushSync(() => root.render(<>{pages.map((p, i) => <PrintSection key={p.s.id} section={p.s} index={i} minHeight={p.minHeight} texts={p.texts} images={p.images} />)}</>));
      // Let images and fonts load before the pages are captured.
      await Promise.all([...host.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
      await document.fonts.ready;
      const els = new Map([...host.querySelectorAll<HTMLElement>("[data-section-id]")].map((el) => [el.dataset.sectionId!, el]));
      parts.push(...await sectionPages(sections, (sid) => els.get(sid), (done, total) => onProgress?.(n + done / total, notebookIds.length)));
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return buildPdf(parts);
}
