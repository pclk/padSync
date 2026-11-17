"use client";

import { useState, type ReactNode } from "react";
import { clozeParts } from "@/lib/blocks";
import { renderInline, renderMarkdown } from "@/lib/markdown";
import { SPACE_PX, type Block, type SpaceSize } from "@/lib/types";

// The study blocks from AI import (schema v2): explanations, derivations, glossaries, concept
// maps, and the "write on top" blocks (blanks, recall, rewrite, prompts, checkpoints). Hidden
// answers stay hidden, in renders too, until the Show chip is tapped. The chip sits above the ink
// layer (z-10), so a pencil tap reveals instead of drawing.

export const spacePx = (size: SpaceSize | number | undefined, fallback: SpaceSize) => (typeof size === "number" ? size : SPACE_PX[size ?? fallback]);

const Md = ({ text, className = "" }: { text: string; className?: string }) => <div className={`prose-pad ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;

function RevealChip({ shown, toggle, label = "answer" }: { shown: boolean; toggle: () => void; label?: string }) {
  return (
    <button
      type="button"
      data-reveal="1"
      className="relative z-10 ml-2 inline-flex items-center rounded-full border border-slate-300 bg-white px-2 py-0.5 align-middle text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-50"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggle}
    >
      {shown ? `Hide ${label}` : `Show ${label}`}
    </button>
  );
}

const useReveal = () => {
  const [shown, setShown] = useState(false);
  return [shown, () => setShown((s) => !s)] as const;
};

const Lines = ({ height }: { height: number }) => <div data-space="1" className="study-lines" style={{ height }} />;

const CALLOUT_TONE: Record<string, string> = {
  definition: "border-blue-400 bg-blue-50/60",
  theorem: "border-indigo-500 bg-indigo-50/60",
  "key-idea": "border-amber-400 bg-amber-50/70",
  intuition: "border-teal-400 bg-teal-50/60",
  example: "border-slate-400 bg-slate-50",
  warning: "border-rose-400 bg-rose-50/60",
  tip: "border-emerald-400 bg-emerald-50/60",
  mnemonic: "border-fuchsia-400 bg-fuchsia-50/60",
  summary: "border-sky-500 bg-sky-50/60",
  note: "border-slate-300 bg-white",
};
const title = (s: string) => s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const Heading = ({ children }: { children: ReactNode }) => <div className="mb-1 text-[15px] font-semibold uppercase tracking-wide text-slate-500">{children}</div>;

export function StudyBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "callout":
      return (
        <div className={`my-3 rounded-r-lg border-l-4 px-4 py-2 ${CALLOUT_TONE[block.style]}`} data-callout={block.style}>
          <div className="text-[15px] font-semibold text-slate-700">
            {title(block.style)}
            {block.title ? `: ${block.title}` : ""}
          </div>
          <Md text={block.text} />
        </div>
      );
    case "steps":
      return <Steps block={block} />;
    case "glossary":
      return <Glossary block={block} />;
    case "conceptMap":
      return <ConceptMap block={block} />;
    case "cloze":
      return <Cloze block={block} />;
    case "recall":
      return (
        <div className="my-3">
          <Heading>{block.title ?? "Recall"}</Heading>
          <ol className="space-y-2">
            {block.items.map((it, i) => (
              <RecallItem key={i} n={i + 1} item={it} />
            ))}
          </ol>
        </div>
      );
    case "rewrite":
      return (
        <div className="my-3">
          <Heading>✎ {block.prompt ?? "Rewrite in your own words"}</Heading>
          <Md text={block.text} className="rounded-lg bg-slate-50 px-4 py-1 text-slate-600" />
          <Lines height={spacePx(block.space, "m")} />
        </div>
      );
    case "prompt":
      return (
        <div className="my-3 border-l-2 border-dashed border-violet-400 pl-3">
          <div className="text-[17px] font-medium text-violet-800">✎ {block.text}</div>
          <div data-space="1" style={{ height: spacePx(block.space, "s") }} />
        </div>
      );
    case "checkpoint":
      return (
        <div className="my-3 rounded-lg border border-slate-200 px-4 py-2">
          <Heading>{block.title ?? "Checkpoint"}</Heading>
          <ul className="space-y-1">
            {block.items.map((it, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-1.5 inline-block h-5 w-5 shrink-0 rounded border-2 border-slate-400" />
                <Md text={it} />
              </li>
            ))}
          </ul>
          {block.space !== undefined && <div data-space="1" style={{ height: spacePx(block.space, "s") }} />}
        </div>
      );
    default:
      return null;
  }
}

function Steps({ block }: { block: Extract<Block, { type: "steps" }> }) {
  const [shown, toggle] = useReveal();
  const hidden = !!block.blankWhy;
  return (
    <div className="my-3">
      {(block.title || block.style) && (
        <Heading>
          {block.title ?? title(block.style!)}
          {hidden && block.steps.some((s) => s.why) && <RevealChip shown={shown} toggle={toggle} label="reasons" />}
        </Heading>
      )}
      {block.problem && <Md text={block.problem} className="mb-1 font-medium" />}
      <ol className="space-y-1">
        {block.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-white">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <Md text={s.text} />
              {hidden ? (
                <div className="flex items-baseline gap-2 text-[17px] text-slate-500">
                  <span className="italic">why?</span>
                  {shown && s.why ? <span className="prose-pad text-blue-800" dangerouslySetInnerHTML={{ __html: renderInline(s.why) }} /> : <span className="study-blank-line h-7 flex-1" />}
                </div>
              ) : (
                s.why && <div className="prose-pad text-[17px] italic text-slate-500" dangerouslySetInnerHTML={{ __html: renderInline(s.why) }} />
              )}
            </div>
          </li>
        ))}
      </ol>
      {block.result && <Md text={`**Result:** ${block.result}`} className="mt-1" />}
    </div>
  );
}

function Glossary({ block }: { block: Extract<Block, { type: "glossary" }> }) {
  const [shown, toggle] = useReveal();
  const hide = !!block.hideDefinitions && !shown;
  return (
    <div className="my-3">
      <Heading>
        {block.title ?? "Glossary"}
        {block.hideDefinitions && <RevealChip shown={shown} toggle={toggle} label="definitions" />}
      </Heading>
      <dl className="divide-y divide-slate-200 rounded-lg border border-slate-200">
        {block.terms.map((t, i) => (
          <div key={i} className="grid grid-cols-[minmax(160px,28%)_1fr] gap-4 px-4 py-1.5">
            <dt className="prose-pad font-semibold" dangerouslySetInnerHTML={{ __html: renderInline(t.term) }} />
            <dd>
              {hide ? <div className="study-blank-line h-9" /> : <Md text={t.definition} />}
              {t.example && !hide && <Md text={`_e.g._ ${t.example}`} className="text-slate-500" />}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ConceptMap({ block }: { block: Extract<Block, { type: "conceptMap" }> }) {
  const label = new Map(block.nodes.map((n) => [n.id, n.label]));
  return (
    <div className="my-3 rounded-lg border border-slate-200 px-4 py-3" data-concept-map="1">
      <Heading>{block.title ?? "Concept map"}</Heading>
      <div className="flex flex-wrap gap-2">
        {block.nodes.map((n) => (
          <div key={n.id} className="rounded-xl border-2 border-slate-700 bg-white px-3 py-1">
            <div className="prose-pad font-semibold" dangerouslySetInnerHTML={{ __html: renderInline(n.label) }} />
            {n.note && <div className="prose-pad text-[15px] text-slate-500" dangerouslySetInnerHTML={{ __html: renderInline(n.note) }} />}
          </div>
        ))}
      </div>
      {block.links.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[17px] text-slate-700">
          {block.links.map((l, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="prose-pad font-medium" dangerouslySetInnerHTML={{ __html: renderInline(label.get(l.from) ?? l.from) }} />
              <span className="text-slate-400">—{l.label ? <span className="prose-pad mx-1 italic text-slate-600" dangerouslySetInnerHTML={{ __html: renderInline(l.label) }} /> : null}→</span>
              <span className="prose-pad font-medium" dangerouslySetInnerHTML={{ __html: renderInline(label.get(l.to) ?? l.to) }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PLACEHOLDER = (i: number) => `⟦${i}⟧`;

function Cloze({ block }: { block: Extract<Block, { type: "cloze" }> }) {
  const [shown, toggle] = useReveal();
  const parts = clozeParts(block.text);
  const answers = parts.filter((p) => p.blank).map((p) => p.text);
  // Render the whole text once (so Markdown and lists still work), then swap each placeholder for
  // a blank: a writing line about as long as the answer.
  let i = 0;
  const src = parts.map((p) => (p.blank ? PLACEHOLDER(i++) : p.text)).join("");
  const html = renderMarkdown(src).replace(/⟦(\d+)⟧/g, (_, n) => {
    const a = answers[Number(n)];
    const width = Math.min(22, Math.max(5, a.length * 0.75 + 2));
    return shown ? `<span class="study-blank revealed">${renderInline(a)}</span>` : `<span class="study-blank" style="min-width:${width}em"></span>`;
  });
  return (
    <div className="my-3">
      <div className="prose-pad study-cloze" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="flex items-center text-[15px] text-slate-500">
        {block.hint && <span className="italic">Hint: {block.hint}</span>}
        <RevealChip shown={shown} toggle={toggle} label={answers.length === 1 ? "answer" : "answers"} />
      </div>
    </div>
  );
}

function RecallItem({ n, item }: { n: number; item: Extract<Block, { type: "recall" }>["items"][number] }) {
  const [shown, toggle] = useReveal();
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-slate-500">{n}.</span>
        <Md text={item.q} className="flex-1" />
        {item.a && <RevealChip shown={shown} toggle={toggle} />}
      </div>
      {shown && item.a && <Md text={item.a} className="ml-6 rounded bg-blue-50 px-3 text-blue-900" />}
      <div data-space="1" style={{ height: spacePx(item.space, "s") }} />
    </li>
  );
}
