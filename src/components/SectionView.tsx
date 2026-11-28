"use client";
import { debugNow, recordSyncPaint, registerDebugProbe } from "@/lib/sync-debug";
import { renderFlag } from "@/lib/render-flags";

import { useLiveQuery } from "dexie-react-hooks";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InkController, Selection, SectionHandle } from "@/ink/controller";
import { strokeBox, unionBox, type Box } from "@/ink/geometry";
import { paintStrokes } from "@/ink/render";
import { paintDelta, planTiles, sameVersions, tileScale } from "@/ink/tiles";
import { renderMarkdown } from "@/lib/markdown";
import { liveChildren, logEvent, putEntities, setDeleted, updateData } from "@/lib/store";
import { PAGE_WIDTH, type ImageEntity, type SectionEntity, type StrokeEntity, type TextBoxData, type TextBoxEntity } from "@/lib/types";

import type { LassoAction } from "@/lib/lasso-settings";
import { PdfBackground } from "./PdfBackground";
import { Blocks, MarginColumn, SectionHeader } from "./SectionContent";
import { CropFrame } from "./CropFrame";
import { ResizeHandles } from "./ResizeHandles";

interface Props {
  section: SectionEntity;
  index: number;
  controller: InkController;
  zoom: number;
  /** This section's selection only, so other sections' memo holds while lassoing. */
  selection: Selection | null;
  draggingIds: Set<string> | null;
  /** The bar of Delete, Duplicate and Done over a selection; off when the lasso circle shows instead. */
  selectionBar?: boolean;
  /** The bar's other actions (Copy, Copy image, Crop), and whether each applies now. */
  onLassoAction?: (a: LassoAction) => void;
  canLasso?: (a: LassoAction) => boolean;
  editingTextId: string | null;
  setEditingTextId: (id: string | null) => void;
  registerEl: (id: string, el: HTMLElement | null) => void;
  textMode: boolean;
  /** The picture being cropped here, and the frame it starts at (NotebookEditor). */
  cropping?: { imageId: string; initial: Box } | null;
  /** The crop frame closed: the part to keep, or null to leave the picture be. */
  onCropDone?: (keep: Box | null) => void;
  /** The iPad is on this page: it is outlined, always. */
  ipadHere?: boolean;
  /** The chat's next message sends this page: all of it, or from sentY0 to sentY1 (the iPad's screen). */
  sent?: boolean;
  sentY0?: number;
  sentY1?: number;
}

export const SectionView = memo(function SectionView(p: Props) {
  const { section, controller } = p;
  const strokes = useLiveQuery(() => liveChildren<StrokeEntity>(section.id, "stroke"), [section.id], [] as StrokeEntity[]);
  const textboxes = useLiveQuery(() => liveChildren<TextBoxEntity>(section.id, "textbox"), [section.id], [] as TextBoxEntity[]);
  const images = useLiveQuery(() => liveChildren<ImageEntity>(section.id, "image"), [section.id], [] as ImageEntity[]);
  const strokesRef = useRef(strokes);
  const imagesRef = useRef(images);
  useLayoutEffect(() => {
    strokesRef.current = strokes;
    imagesRef.current = images;
  }, [strokes, images]);

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
  const imageBottom = images.reduce((m, t) => Math.max(m, t.data.y + t.data.h), 0);
  // Sections grow as you write near the bottom, so there is always room below your ink.
  const height = Math.ceil(Math.max(section.data.minHeight, contentH + 80, inkBottom + 360, textBottom + 200, imageBottom + 200));

  const handle = useMemo<SectionHandle>(
    () => ({
      id: section.id,
      get el() {
        return surfaceRef.current!;
      },
      strokes: () => strokesRef.current,
      images: () => imagesRef.current,
    }),
    [section.id],
  );

  useEffect(() => controller.registerSection(handle), [controller, handle]);
  // A stroke on a section that unmounts never gets its pointerup here; don't leave it open.
  useEffect(() => () => controller.endGesture(section.id), [controller, section.id]);

  // Empty transparent ink canvases compete with PDF pages for Safari’s bitmap memory.
  const tiles = useMemo(() => planTiles(height, strokes).filter(tile => tile.strokes.length > 0), [height, strokes]);
  const margin = section.data.margin;
  const marginPx = margin ? Math.round(PAGE_WIDTH * (margin.width ?? 0.3)) : 0;

  const cropImage = p.cropping ? images.find((im) => im.id === p.cropping!.imageId) : undefined;
  // While a picture is cropped its frame stands in for the selection box.
  const sel = cropImage ? null : p.selection;
  const { registerEl } = p;
  const sectionRef = useCallback((el: HTMLElement | null) => registerEl(section.id, el), [registerEl, section.id]);

  // With the sectionScale flag off, the editor scales the whole notebook instead (the old way).
  const zoom = renderFlag("sectionScale") ? p.zoom : 1;
  return (
    // Layout zoom keeps page coordinates in notebook units without a persistent transformed
    // layer for Safari to tile. The wrapper also keeps zoom out of export and magnifier clones.
    <div className="shrink-0" style={{ width: PAGE_WIDTH, zoom }}>
    <section
      ref={sectionRef}
      data-section-id={section.id}
      className={`paper template-${section.data.template} relative bg-white shadow-[0_1px_3px_rgb(15_23_42/0.08),0_8px_24px_-8px_rgb(15_23_42/0.12)]`}
      style={{ width: PAGE_WIDTH, height }}
    >
      {section.data.pdf && <PdfBackground page={section.data.pdf} zoom={p.zoom} />}
      {margin && <MarginColumn margin={margin} width={marginPx} />}
      <div ref={contentRef} className="section-content absolute top-0 px-14 pt-8 pb-6" style={{ left: margin?.side === "left" ? marginPx : 0, right: margin && margin.side !== "left" ? marginPx : 0 }}>
        {!section.data.pdf && <SectionHeader section={section} index={p.index} />}
        <Blocks blocks={section.data.blocks} />
      </div>

      {/* Pictures sit under the ink, so they can be written on. */}
      {images.map((im) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={im.id}
          src={im.data.src}
          alt=""
          draggable={false}
          data-page-image={im.id}
          className="pointer-events-none absolute select-none"
          style={{ left: im.data.x, top: im.data.y, width: im.data.w, height: im.data.h, visibility: p.draggingIds?.has(im.id) ? "hidden" : undefined }}
        />
      ))}

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
          data-page-overlay
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
          // Double-clicking a selected picture crops it.
          onDoubleClick={() => (p.canLasso?.("crop") ?? false) && p.onLassoAction?.("crop")}
          title="Drag to move, or a handle to resize"
        >
          {/* Kept mounted while resizing (hidden with the box), as the pressed one holds the pointer. */}
          {sel.ids.size > 0 && (
            <ResizeHandles w={sel.box.maxX - sel.box.minX} h={sel.box.maxY - sel.box.minY} zoom={p.zoom} onDown={(k, e) => controller.grabHandle(e.nativeEvent, handle, e.currentTarget, k)} />
          )}
          {p.selectionBar !== false && <div className="pointer-events-auto absolute -top-11 left-0 flex gap-1 rounded-xl bg-slate-900 p-1 text-sm text-white shadow-lg">
            <button className="rounded px-3 py-1 hover:bg-slate-700" onPointerDown={(e) => e.stopPropagation()} onClick={() => controller.deleteSelection()}>
              Delete
            </button>
            <button className="rounded px-3 py-1 hover:bg-slate-700" onPointerDown={(e) => e.stopPropagation()} onClick={() => controller.duplicateSelection(handle)}>
              Duplicate
            </button>
            {p.onLassoAction &&
              ([["copy", "Copy"], ["copyImage", "Copy image"], ["crop", "Crop"]] as const)
                .filter(([a]) => p.canLasso?.(a) ?? true)
                .map(([a, label]) => (
                  <button key={a} className="whitespace-nowrap rounded px-3 py-1 hover:bg-slate-700" onPointerDown={(e) => e.stopPropagation()} onClick={() => p.onLassoAction!(a)}>
                    {label}
                  </button>
                ))}
          </div>}
        </div>
      )}
      {p.sent && (
        // Tinted, edged in the accent: what goes to the AI with the next message.
        <div
          aria-hidden
          data-sent-to-ai
          data-page-overlay
          className="pointer-events-none absolute inset-x-0 z-10 bg-brand-500/[0.05]"
          style={{ top: p.sentY0 ?? 0, height: (p.sentY1 ?? height) - (p.sentY0 ?? 0), boxShadow: `inset 0 0 0 ${2 / p.zoom}px color-mix(in srgb, var(--color-brand-500) 60%, transparent)` }}
        >
          <span className="absolute right-0 top-0 origin-top-right whitespace-nowrap rounded-bl-md bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ transform: `scale(${1 / p.zoom})` }}>
            Sent to AI
          </span>
        </div>
      )}
      {p.ipadHere && (
        // Just outside the page, so it never covers the writing.
        <div
          aria-hidden
          data-ipad-here
          data-page-overlay
          className="pointer-events-none absolute z-10 border-amber-500"
          style={{ inset: -6 / p.zoom, borderWidth: 2.5 / p.zoom, borderStyle: "solid", borderRadius: 8 / p.zoom }}
        >
          <span className="absolute bottom-full left-0 origin-bottom-left whitespace-nowrap rounded-md bg-amber-500 px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ transform: `scale(${1 / p.zoom})`, marginBottom: 3 / p.zoom }}>
            iPad
          </span>
        </div>
      )}
      {cropImage && p.onCropDone && (
        <CropFrame
          key={cropImage.id}
          image={{ minX: cropImage.data.x, minY: cropImage.data.y, maxX: cropImage.data.x + cropImage.data.w, maxY: cropImage.data.y + cropImage.data.h }}
          initial={p.cropping!.initial}
          zoom={p.zoom}
          onDone={p.onCropDone}
        />
      )}
    </section>
    </div>
  );
});

// Repaints after a zoom run once the frame has painted, a few tiles per frame. A tile in view
// paints its new bitmap off screen and returns a swap; the swaps all run in one frame once every
// tile in view is ready, so the page sharpens in one step instead of tile by tile. Tiles off
// screen repaint in place, after those.
type Repaint = () => (() => void) | void;
const inView = new Set<Repaint>();
const offView = new Set<Repaint>();
const swaps = new Map<Repaint, () => void>();
let repaintScheduled = false;
let swapScheduled = false;
registerDebugProbe("Ink tiles", () => ({ queuedRepaints: inView.size + offView.size, waitingSwaps: swaps.size }));

/** Queues `paint`; pass `discard` for a tile in view, whose paint returns its swap. */
function queueRepaint(paint: Repaint, discard?: () => void) {
  (discard ? inView : offView).add(paint);
  scheduleRepaints();
  return () => {
    inView.delete(paint);
    offView.delete(paint);
    if (swaps.delete(paint)) discard?.();
    scheduleSwaps(); // the other tiles in view may have been waiting on this one
  };
}

function scheduleRepaints() {
  if (repaintScheduled) return;
  repaintScheduled = true;
  requestAnimationFrame(() => setTimeout(runRepaints));
}

function runRepaints() {
  repaintScheduled = false;
  const end = performance.now() + 8;
  for (const queue of [inView, offView]) {
    for (const paint of queue) {
      queue.delete(paint);
      const swap = paint();
      if (swap) swaps.set(paint, swap);
      if (performance.now() > end) break;
    }
    if (performance.now() > end) break;
  }
  scheduleSwaps();
  if (inView.size || offView.size) scheduleRepaints();
}

function scheduleSwaps() {
  if (swapScheduled || inView.size || !swaps.size) return;
  swapScheduled = true;
  requestAnimationFrame(() => {
    swapScheduled = false;
    if (inView.size) return; // a new zoom queued more; they swap with those
    for (const swap of swaps.values()) swap();
    swaps.clear();
  });
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

  // A layout effect, so a tile that comes into view has its ink in the same frame.
  useLayoutEffect(() => {
    const c = canvas.current;
    const el = holder.current;
    if (!visible || !c || !el) {
      painted.current = null;
      return;
    }
    // Quarter steps: half steps drew 80% zoom at 2.0x for 1.6x, 56% more pixels.
    const scale = tileScale(zoom, window.devicePixelRatio || 1, renderFlag("quarterSteps"));
    const w = Math.round(PAGE_WIDTH * scale);
    const h = Math.round(height * scale);
    const shown = hidden ? strokes.filter((s) => !hidden.has(s.id)) : strokes;
    const done = (list: StrokeEntity[], started: number) => {
      painted.current = { strokes: shown, scale, hidden };
      recordSyncPaint(list, debugNow() - started);
      controller.ackPainted(list.map((s) => s.id));
    };
    const draw = (ctx: CanvasRenderingContext2D, list: StrokeEntity[]) => {
      ctx.setTransform(scale, 0, 0, scale, 0, -top * scale);
      paintStrokes(ctx, list);
    };
    const paint = () => {
      const started = debugNow();
      const prev = painted.current;
      // Null once Safari's canvas memory is spent; skip rather than throw and take the page down.
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const delta = prev && prev.scale === scale && prev.hidden === hidden && c.width === w && c.height === h ? paintDelta(prev.strokes, shown) : null;
      if (!delta) {
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
      }
      draw(ctx, delta ?? shown);
      done(delta ?? shown, started);
    };
    if (!painted.current || painted.current.scale === scale) return void paint();
    // After a zoom the old bitmap still shows, stretched by CSS as it was during the pinch.
    // Repainting every tile right away blocks Safari from redrawing the page itself, which
    // flashes black, so the repaints are queued. Tiles off screen repaint in place; tiles in view
    // paint off screen first and swap in together (one extra bitmap each until then).
    const box = el.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) return queueRepaint(paint);
    let off: HTMLCanvasElement | null = null;
    const free = () => {
      if (off) off.width = off.height = 0;
      off = null;
    };
    return queueRepaint(() => {
      const started = debugNow();
      off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d");
      if (!octx) {
        free();
        return paint();
      }
      draw(octx, shown);
      return () => {
        const ctx = c.getContext("2d");
        if (ctx && off) {
          if (c.width !== w) c.width = w;
          if (c.height !== h) c.height = h;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(off, 0, 0);
          done(shown, started);
        }
        free();
      };
    }, free);
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
