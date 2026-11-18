"use client";
import { debugNow, recordSyncPaint, registerDebugProbe } from "@/lib/sync-debug";
import { renderFlag } from "@/lib/render-flags";

import { useLiveQuery } from "dexie-react-hooks";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InkController, Selection, SectionHandle } from "@/ink/controller";
import { strokeBox, unionBox } from "@/ink/geometry";
import { paintStrokes } from "@/ink/render";
import { paintDelta, planTiles, sameVersions } from "@/ink/tiles";
import { highlight, renderInline, renderMarkdown } from "@/lib/markdown";
import { liveChildren, logEvent, putEntities, setDeleted, updateData } from "@/lib/store";
import { PAGE_WIDTH, SPACE_PX, type Block, type SectionData, type SectionEntity, type StrokeEntity, type TextBoxData, type TextBoxEntity } from "@/lib/types";

import { PdfBackground } from "./PdfBackground";
import { StudyBlock } from "./StudyBlocks";

// iOS caps canvas area; 2.95 keeps a full-width tile under 4096px wide.
const MAX_SCALE = 2.95;

interface Props {
  section: SectionEntity;
  index: number;
  controller: InkController;
  zoom: number;
  /** This section's selection only, so other sections' memo holds while lassoing. */
  selection: Selection | null;
  draggingIds: Set<string> | null;
  editingTextId: string | null;
  setEditingTextId: (id: string | null) => void;
  registerEl: (id: string, el: HTMLElement | null) => void;
  textMode: boolean;
}

export const SectionView = memo(function SectionView(p: Props) {
  const { section, controller } = p;
  const strokes = useLiveQuery(() => liveChildren<StrokeEntity>(section.id, "stroke"), [section.id], [] as StrokeEntity[]);
  const textboxes = useLiveQuery(() => liveChildren<TextBoxEntity>(section.id, "textbox"), [section.id], [] as TextBoxEntity[]);
  const strokesRef = useRef(strokes);
  useLayoutEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(0);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentH(el.offsetHeight));
    ro.observe(el);
    setContentH(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const inkBottom = useMemo(() => unionBox(strokes.map(strokeBox))?.maxY ?? 0, [strokes]);
  const textBottom = textboxes.reduce((m, t) => Math.max(m, t.data.y + 120), 0);
  // Sections grow as you write near the bottom, so there is always room below your ink.
  const height = Math.ceil(Math.max(section.data.minHeight, contentH + 80, inkBottom + 360, textBottom + 200));

  const handle = useMemo<SectionHandle>(
    () => ({
      id: section.id,
      get el() {
        return surfaceRef.current!;
      },
      strokes: () => strokesRef.current,
    }),
    [section.id],
  );

  // A stroke on a section that unmounts never gets its pointerup here; don't leave it open.
  useEffect(() => () => controller.endGesture(section.id), [controller, section.id]);

  const tiles = useMemo(() => planTiles(height, strokes), [height, strokes]);
  const margin = section.data.margin;
  const marginPx = margin ? Math.round(PAGE_WIDTH * (margin.width ?? 0.3)) : 0;

  const sel = p.selection;
  const { registerEl } = p;
  const sectionRef = useCallback((el: HTMLElement | null) => registerEl(section.id, el), [registerEl, section.id]);

  // With the sectionScale flag off, the editor scales the whole notebook instead (the old way).
  const zoom = renderFlag("sectionScale") ? p.zoom : 1;
  return (
    // The box takes the section's size on screen; the section inside is laid out at page size and
    // scaled into it, so each section is its own (small) scaled layer.
    <div className="shrink-0" style={{ width: PAGE_WIDTH * zoom, height: height * zoom }}>
    <section
      ref={sectionRef}
      data-section-id={section.id}
      className={`paper template-${section.data.template} relative bg-white shadow-[0_1px_3px_rgb(15_23_42/0.08),0_8px_24px_-8px_rgb(15_23_42/0.12)]`}
      style={{ width: PAGE_WIDTH, height, transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: "0 0" }}
    >
      {section.data.pdf && <PdfBackground page={section.data.pdf} zoom={p.zoom} />}
      {margin && <MarginColumn margin={margin} width={marginPx} />}
      <div ref={contentRef} className="section-content absolute top-0 px-14 pt-8 pb-6" style={{ left: margin?.side === "left" ? marginPx : 0, right: margin && margin.side !== "left" ? marginPx : 0 }}>
        {!section.data.pdf && <SectionHeader section={section} index={p.index} />}
        <Blocks blocks={section.data.blocks} />
      </div>

      {tiles.map((t) => (
        <InkTile key={t.top} top={t.top} height={t.h} strokes={t.strokes} zoom={p.zoom} hidden={p.draggingIds} controller={controller} />
      ))}

      <div
        ref={surfaceRef}
        className="ink-surface absolute inset-0"
        style={{ cursor: p.textMode ? "text" : "crosshair" }}
        onPointerDown={(e) => {
          if (p.editingTextId) p.setEditingTextId(null);
          controller.down(e.nativeEvent, handle);
        }}
        onPointerMove={(e) => controller.move(e.nativeEvent, handle)}
        onPointerUp={(e) => controller.up(e.nativeEvent, handle)}
        onPointerCancel={(e) => controller.up(e.nativeEvent, handle)}
        onLostPointerCapture={(e) => controller.lostCapture(e.nativeEvent, handle)}
        onPointerLeave={() => controller.leave()}
      />

      {textboxes.map((tb) => (
        <TextBox
          key={tb.id}
          tb={tb}
          editing={p.editingTextId === tb.id}
          interactive={p.textMode}
          onEdit={() => p.setEditingTextId(tb.id)}
          onDone={() => p.setEditingTextId(null)}
          zoom={p.zoom}
        />
      ))}

      {sel && (
        // The box is the drag handle: press anywhere in it (Pencil, mouse or finger) and move. It
        // stays mounted, just invisible, while dragging so it keeps the pointer capture.
        <div
          className={`ink-grab absolute cursor-move touch-none rounded border-2 border-dashed border-blue-500/80 bg-blue-500/5 ${p.draggingIds ? "opacity-0" : ""}`}
          style={{ left: sel.box.minX, top: sel.box.minY, width: sel.box.maxX - sel.box.minX, height: sel.box.maxY - sel.box.minY }}
          onPointerDown={(e) => {
            e.stopPropagation();
            controller.grab(e.nativeEvent, handle, e.currentTarget);
          }}
          onPointerMove={(e) => controller.move(e.nativeEvent, handle)}
          onPointerUp={(e) => controller.up(e.nativeEvent, handle)}
          onPointerCancel={(e) => controller.up(e.nativeEvent, handle)}
          onLostPointerCapture={(e) => controller.lostCapture(e.nativeEvent, handle)}
          title="Drag to move"
        >
          <div className="pointer-events-auto absolute -top-11 left-0 flex gap-1 rounded-xl bg-slate-900 p-1 text-sm text-white shadow-lg">
            <button className="rounded px-3 py-1 hover:bg-slate-700" onPointerDown={(e) => e.stopPropagation()} onClick={() => controller.deleteSelection()}>
              Delete
            </button>
            <button className="rounded px-3 py-1 hover:bg-slate-700" onPointerDown={(e) => e.stopPropagation()} onClick={() => controller.setSelection(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </section>
    </div>
  );
});

const KIND_LABEL: Record<NonNullable<SectionData["kind"]>, [string, string]> = {
  problem: ["Problem", "bg-slate-100 text-slate-600"],
  explanation: ["Explanation", "bg-blue-50 text-blue-700"],
  "worked-example": ["Worked example", "bg-indigo-50 text-indigo-700"],
  notes: ["Notes", "bg-amber-50 text-amber-800"],
  summary: ["Summary", "bg-sky-50 text-sky-700"],
  review: ["Review", "bg-emerald-50 text-emerald-700"],
  reference: ["Reference", "bg-slate-100 text-slate-500"],
};

function SectionHeader({ section, index }: { section: SectionEntity; index: number }) {
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
function MarginColumn({ margin, width }: { margin: NonNullable<SectionData["margin"]>; width: number }) {
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

const Blocks = memo(function Blocks({ blocks }: { blocks: Block[] }) {
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

// Repaints after a zoom run once the frame has painted, a few tiles per frame.
const repaints = new Set<() => void>();
let repaintScheduled = false;
registerDebugProbe("Ink tiles", () => ({ queuedRepaints: repaints.size }));

function queueRepaint(paint: () => void) {
  repaints.add(paint);
  scheduleRepaints();
  return () => void repaints.delete(paint);
}

function scheduleRepaints() {
  if (repaintScheduled) return;
  repaintScheduled = true;
  requestAnimationFrame(() => setTimeout(runRepaints));
}

function runRepaints() {
  repaintScheduled = false;
  const end = performance.now() + 8;
  for (const paint of repaints) {
    repaints.delete(paint);
    paint();
    if (performance.now() > end) break;
  }
  if (repaints.size) scheduleRepaints();
}

interface TileProps {
  top: number;
  height: number;
  strokes: StrokeEntity[];
  zoom: number;
  hidden: Set<string> | null;
  controller: InkController;
}

// A stroke written in one tile leaves the other tiles of the section alone.
const sameTile = (a: TileProps, b: TileProps) =>
  a.top === b.top && a.height === b.height && a.zoom === b.zoom && a.hidden === b.hidden && a.controller === b.controller && sameVersions(a.strokes, b.strokes);

const InkTile = memo(function InkTile({ top, height, strokes, zoom, hidden, controller }: TileProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    // Half a screen of ink ready either side; every tile kept is a bitmap of up to ~37 MB.
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "50% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // What the bitmap currently shows, so a new stroke on top can be painted alone.
  const painted = useRef<{ strokes: StrokeEntity[]; scale: number; hidden: Set<string> | null } | null>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!visible || !c) {
      painted.current = null;
      return;
    }
    // In quarter steps: close to what the zoom shows (half steps drew 80% zoom at 2.0x for 1.6x,
    // 56% more pixels), while small zoom changes still keep the bitmaps.
    const steps = renderFlag("quarterSteps") ? 4 : 2;
    const scale = Math.min(Math.ceil((window.devicePixelRatio || 1) * zoom * steps) / steps, MAX_SCALE);
    const paint = () => {
      const paintStarted = debugNow();
      const w = Math.round(PAGE_WIDTH * scale);
      const h = Math.round(height * scale);
      const shown = hidden ? strokes.filter((s) => !hidden.has(s.id)) : strokes;
      const prev = painted.current;
      // Null once Safari's canvas memory is spent; skip rather than throw and take the page down.
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const delta = prev && prev.scale === scale && prev.hidden === hidden && c.width === w && c.height === h ? paintDelta(prev.strokes, shown) : null;
      if (delta) {
        ctx.setTransform(scale, 0, 0, scale, 0, -top * scale);
        paintStrokes(ctx, delta);
      } else {
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.setTransform(scale, 0, 0, scale, 0, -top * scale);
        paintStrokes(ctx, shown);
      }
      painted.current = { strokes: shown, scale, hidden };
      recordSyncPaint(delta ?? shown, debugNow() - paintStarted);
      controller.ackPainted((delta ?? shown).map((s) => s.id));
    };
    // After a zoom the old bitmap still shows, stretched by CSS; repainting every tile at the new
    // resolution right away blocks Safari from redrawing the page itself, which flashes black.
    if (painted.current && painted.current.scale !== scale) return queueRepaint(paint);
    paint();
  }, [visible, strokes, zoom, height, top, hidden, controller]);

  useEffect(() => {
    // Release the bitmap when scrolled away; Safari keeps canvas memory until resized.
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      painted.current = null;
    };
  }, [visible]);

  return (
    <div ref={holder} className="pointer-events-none absolute left-0" style={{ top, width: PAGE_WIDTH, height }}>
      {visible && <canvas ref={canvas} style={{ width: PAGE_WIDTH, height }} />}
    </div>
  );
}, sameTile);

function TextBox({ tb, editing, interactive, onEdit, onDone, zoom }: { tb: TextBoxEntity; editing: boolean; interactive: boolean; onEdit: () => void; onDone: () => void; zoom: number }) {
  const drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const style = { left: tb.data.x + offset[0], top: tb.data.y + offset[1], width: tb.data.w, fontSize: tb.data.fontSize, color: tb.data.color };
  // Every section re-renders on zoom; don't re-run markdown and KaTeX for each text box then.
  const html = useMemo(() => renderMarkdown(tb.data.text), [tb.data.text]);

  if (editing) return <TextEditor tb={tb} style={style} onDone={onDone} />;

  return (
    <div
      data-textbox="1"
      className={`textbox absolute z-10 rounded p-1 leading-snug ${interactive ? "cursor-move ring-1 ring-slate-300 hover:ring-blue-400" : "pointer-events-none"}`}
      style={style}
      onDoubleClick={onEdit}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: 0, y: 0 };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        d.x = (e.clientX - d.sx) / zoom;
        d.y = (e.clientY - d.sy) / zoom;
        setOffset([d.x, d.y]);
      }}
      onPointerUp={async () => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (Math.abs(d.x) < 3 && Math.abs(d.y) < 3) {
          setOffset([0, 0]);
          onEdit();
          return;
        }
        await putEntities([{ ...tb, data: { ...tb.data, x: tb.data.x + d.x, y: tb.data.y + d.y } }]);
        setOffset([0, 0]);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Mounted fresh for each edit, so the draft always starts from the saved text. */
function TextEditor({ tb, style, onDone }: { tb: TextBoxEntity; style: React.CSSProperties; onDone: () => void }) {
  const [draft, setDraft] = useState(tb.data.text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [draft]);

  const save = async () => {
    onDone();
    if (!draft.trim()) {
      await setDeleted([tb.id], true);
      return;
    }
    if (draft !== tb.data.text) {
      await updateData<TextBoxData>(tb.id, (d) => ({ ...d, text: draft }));
      void logEvent(tb.notebookId, tb.parentId, "text_edit", { id: tb.id, length: draft.length });
    }
  };

  return (
    <textarea
      data-textbox="1"
      ref={ref}
      className="textbox-edit absolute z-20 resize-none rounded border border-blue-400 bg-white/90 p-1 leading-snug outline-none"
      style={style}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
      }}
      placeholder="Type… ($LaTeX$ supported)"
    />
  );
}
