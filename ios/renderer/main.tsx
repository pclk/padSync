import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Blocks, MarginColumn, SectionHeader } from "@/components/SectionContent";
import { PAGE_WIDTH, type SectionEntity } from "@/lib/types";
import { DEFAULT_CONTEXT, buildBundle, type BundleInput, type ContextOptions } from "@/lib/context";
import { readView } from "@/lib/section-span";

// The iPad app's block renderer: an offscreen WKWebView loads this page from the app bundle,
// calls `padsyncRender` with a section and snapshots the result behind the PencilKit canvas.
// Same components and CSS as SectionView.tsx, so the content height (and the ink on top) lines
// up with the web.

const root = createRoot(document.getElementById("root")!);

function Section({ section, index }: { section: SectionEntity; index: number }) {
  const margin = section.data.margin;
  const marginPx = margin ? Math.round(PAGE_WIDTH * (margin.width ?? 0.3)) : 0;
  return (
    <section className="paper relative" style={{ width: PAGE_WIDTH, background: "transparent" }}>
      {margin && <MarginColumn margin={margin} width={marginPx} />}
      <div id="content" className="section-content px-14 pt-8 pb-6" style={{ marginLeft: margin?.side === "left" ? marginPx : 0, marginRight: margin && margin.side !== "left" ? marginPx : 0 }}>
        {!section.data.pdf && <SectionHeader section={section} index={index} />}
        <Blocks blocks={section.data.blocks ?? []} />
      </div>
    </section>
  );
}

async function settle() {
  const images = [...document.images].filter((img) => !img.complete);
  await Promise.all(images.map((img) => new Promise((done) => { img.onload = img.onerror = done; })));
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
}

/** Renders a section and returns its content height (`contentH` in SectionView.tsx) and the
 *  height to snapshot, which also covers the annotation column's prompts. */
async function padsyncRender(section: SectionEntity, index: number) {
  flushSync(() => root.render(<Section section={section} index={index} />));
  await settle();
  const content = document.getElementById("content")!;
  const margin = document.querySelector<HTMLElement>("[data-margin]");
  const marginBottom = margin ? Math.max(0, ...[...margin.children].map((c) => (c as HTMLElement).offsetTop + (c as HTMLElement).offsetHeight)) : 0;
  return { contentHeight: content.offsetHeight, snapshotHeight: Math.ceil(Math.max(content.offsetHeight, marginBottom)) };
}

Object.assign(window, { padsyncRender });

/** The web's own Ask AI bundle builder (src/lib/context.ts), so a prompt sent from the app carries
 *  exactly the files the web would send. `scope` is a prompt's context (section, selection,
 *  notebook); renders and the selection crop come from the app. */
function padsyncBundle(input: BundleInput, scope: "section" | "selection" | "notebook", sectionId: string, span?: { sectionIds: string[]; view: unknown }) {
  const o: ContextOptions = {
    ...DEFAULT_CONTEXT,
    scope: scope === "selection" ? "selection" : scope === "notebook" ? "all" : "sections",
    // A section prompt may cover a neighbour or the screen (src/lib/section-span.ts).
    sectionIds: scope === "section" ? (span?.sectionIds.length ? span.sectionIds : [sectionId]) : [],
    view: scope === "section" ? readView(span?.view) : null,
  };
  return buildBundle(input, o);
}

Object.assign(window, { padsyncBundle });
