import { memo } from "react";
import { highlight, renderInline, renderMarkdown } from "@/lib/markdown";
import { SPACE_PX, type Block, type SectionData, type SectionEntity } from "@/lib/types";
import { StudyBlock } from "./StudyBlocks";

// A section's printed content: header, study blocks and the annotation column. Shared by the
// editor and the iPad app's bundled renderer (ios/renderer), so both lay blocks out the same.

const KIND_LABEL: Record<NonNullable<SectionData["kind"]>, [string, string]> = {
  problem: ["Problem", "bg-slate-100 text-slate-600"],
  explanation: ["Explanation", "bg-blue-50 text-blue-700"],
  "worked-example": ["Worked example", "bg-indigo-50 text-indigo-700"],
  notes: ["Notes", "bg-amber-50 text-amber-800"],
  summary: ["Summary", "bg-sky-50 text-sky-700"],
  review: ["Review", "bg-emerald-50 text-emerald-700"],
  reference: ["Reference", "bg-slate-100 text-slate-500"],
};

export function SectionHeader({ section, index }: { section: SectionEntity; index: number }) {
  const d = section.data;
  if (!d.title && d.marks == null && d.timeLimitMinutes == null && !d.kind && !d.objectives?.length && !d.sources?.length) return null;
  const kind = d.kind ? KIND_LABEL[d.kind] : null;
  return (
    <div className="mb-3 border-b border-slate-200 pb-2 text-slate-500">
      <div className="flex items-baseline gap-3">
        <span className="text-[15px] font-semibold tracking-wide text-slate-800">{d.title ?? `Section ${index + 1}`}</span>
        {kind && <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${kind[1]}`}>{kind[0]}</span>}
        {d.marks != null && <span className="text-sm">[{d.marks} marks]</span>}
        {d.timeLimitMinutes != null && <span className="text-sm">{d.timeLimitMinutes} min</span>}
        {d.tags?.length ? <span className="ml-auto text-xs">{d.tags.join(" · ")}</span> : null}
      </div>
      {d.sources?.map(source => <p key={source.attachmentId} className="mt-1 text-xs text-slate-500">Source: {source.name ?? "Lecture PDF"}{source.pages?.length ? ` · pages ${source.pages.join(", ")}` : " · all pages"}</p>)}
      {d.objectives?.length ? (
        <ul className="mt-1 text-sm text-slate-600">
          {d.objectives.map((o, i) => (
            <li key={i} className="prose-pad !text-sm" dangerouslySetInnerHTML={{ __html: renderInline(`◎ ${o}`) }} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The annotation column: ruled, with the AI's prompts at the top. Purely visual; ink goes on top. */
export function MarginColumn({ margin, width }: { margin: NonNullable<SectionData["margin"]>; width: number }) {
  return (
    <aside
      data-margin="1"
      className={`study-margin pointer-events-none absolute inset-y-0 px-4 pt-8 ${margin.side === "left" ? "left-0 border-r" : "right-0 border-l"} border-dashed border-slate-300`}
      style={{ width }}
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Your notes</div>
      {margin.prompts?.map((p, i) => (
        <div key={i} className="prose-pad mb-24 !text-[15px] italic !text-slate-500" dangerouslySetInnerHTML={{ __html: renderInline(`✎ ${p}`) }} />
      ))}
    </aside>
  );
}

export const Blocks = memo(function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </>
  );
});

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "markdown":
      return <div className="prose-pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />;
    case "code":
      return (
        <pre className="hljs my-3 overflow-hidden rounded-lg text-[15px] leading-relaxed">
          <code dangerouslySetInnerHTML={{ __html: highlight(block.code, block.language) }} />
        </pre>
      );
    case "image":
      return (
        <figure className="my-3" style={{ width: `${(block.width ?? 0.6) * 100}%` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={block.src} alt={block.alt ?? ""} data-block-image="1" className="w-full rounded" draggable={false} />
          {block.caption && <figcaption className="mt-1 text-sm text-slate-500">{block.caption}</figcaption>}
        </figure>
      );
    case "space":
      return <div data-space="1" style={{ height: typeof block.size === "number" ? block.size : SPACE_PX[block.size] }} />;
    case "divider":
      return <hr className="my-4 border-slate-300" />;
    default:
      return <StudyBlock block={block} />;
  }
}
