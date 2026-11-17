import { emitActivity } from "@/lib/activity";
import { db, deviceId } from "@/lib/db";
import { logEvent, moveStrokes, newEntity, putEntities, setDeleted } from "@/lib/store";
import { STROKE_STRIDE, type StrokeData, type StrokeEntity } from "@/lib/types";
import { dataBox, hitStrokes, lassoStrokes, strokeBox, unionBox, type Box } from "./geometry";
import { paintStroke, strokePath, cachedPath, seedPath } from "./render";
import { UndoStack } from "./undo";

// Turns pointer input on a section into strokes, erasures and lasso moves. The in-progress
// gesture is drawn on one viewport-sized overlay canvas; committed ink lives in each section's
// tile canvases. Fingers are never ink (palm rejection): only pen and mouse reach here.

export type ToolKind = "pen" | "highlighter" | "eraser" | "lasso" | "text";

export interface ToolState {
  kind: ToolKind;
  penColor: string;
  penSize: number;
  hlColor: string;
  hlSize: number;
  eraserSize: number;
}

export interface SectionHandle {
  id: string;
  el: HTMLElement;
  strokes: () => StrokeEntity[];
}

export interface Selection {
  sectionId: string;
  ids: Set<string>;
  box: Box;
}

type Gesture =
  | { type: "ink"; sec: SectionHandle; rect: DOMRect; data: StrokeData; predicted: number[]; t0: number; pointerId: number }
  | { type: "erase"; sec: SectionHandle; rect: DOMRect; last: [number, number]; erased: Set<string>; at: [number, number]; pointerId: number }
  | { type: "lasso"; sec: SectionHandle; rect: DOMRect; poly: number[][]; pointerId: number }
  | { type: "drag"; sec: SectionHandle; rect: DOMRect; start: [number, number]; dx: number; dy: number; strokes: StrokeEntity[]; pointerId: number };

interface Pending {
  data: StrokeData;
  /** Outline computed once at commit; redrawn every frame until the tile has painted it. */
  path: Path2D;
  sec: SectionHandle;
  until: number;
}

export interface ControllerCallbacks {
  onSelection: (s: Selection | null) => void;
  onDragging: (ids: Set<string> | null) => void;
  onTextCreate: (sectionId: string, x: number, y: number) => void;
}

const round = (v: number, f: number) => Math.round(v * f) / f;

export class InkController {
  tool: ToolState;
  zoom = 1;
  notebookId: string;
  readonly undo = new UndoStack();
  selection: Selection | null = null;

  private live: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private gesture: Gesture | null = null;
  private hover: { sec: SectionHandle; x: number; y: number } | null = null;
  private pending = new Map<string, Pending>();
  private frame = 0;
  private cb: ControllerCallbacks;

  constructor(notebookId: string, tool: ToolState, cb: ControllerCallbacks) {
    this.notebookId = notebookId;
    this.tool = tool;
    this.cb = cb;
  }

  configure(tool: ToolState, zoom: number) {
    this.tool = tool;
    this.zoom = zoom;
  }

  attachLive(canvas: HTMLCanvasElement | null) {
    if (this.live && this.live !== canvas) {
      this.live.width = 0;
      this.live.height = 0;
    }
    if (!canvas) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.pending.clear();
      this.gesture = null;
      this.hover = null;
    }
    this.live = canvas;
    // desynchronized hints a low-latency canvas where supported.
    this.ctx = canvas?.getContext("2d", { desynchronized: true }) ?? null;
    this.resizeLive();
  }

  resizeLive() {
    if (!this.live) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // The CSS size must match the backing store exactly. With 100vh, iPad Safari stretches the
    // overlay to the toolbar-collapsed height, so live ink lands below the Pencil tip and then
    // jumps when the tile paints it.
    this.live.style.width = `${w}px`;
    this.live.style.height = `${h}px`;
    this.live.width = Math.round(w * dpr);
    this.live.height = Math.round(h * dpr);
    this.requestFrame();
  }

  setSelection(s: Selection | null) {
    this.selection = s;
    this.cb.onSelection(s);
  }

  /** Called by tiles after they paint, so the overlay copy of a just-committed stroke can go. */
  ackPainted(ids: Iterable<string>) {
    let changed = false;
    for (const id of ids) changed = this.pending.delete(id) || changed;
    if (changed) this.requestFrame();
  }

  isDrawing() {
    return this.gesture !== null;
  }

  private local(e: PointerEvent, rect: DOMRect): [number, number] {
    return [(e.clientX - rect.left) / this.zoom, (e.clientY - rect.top) / this.zoom];
  }

  private accepts(e: PointerEvent) {
    if (e.pointerType === "touch") return false;
    if (e.pointerType === "mouse" && e.button !== 0) return false;
    return true;
  }

  down(e: PointerEvent, sec: SectionHandle) {
    if (!this.accepts(e) || this.gesture) return;
    const rect = sec.el.getBoundingClientRect();
    const [x, y] = this.local(e, rect);
    this.hover = null;
    const kind = this.tool.kind;

    if (kind === "text") {
      this.cb.onTextCreate(sec.id, x, y);
      return;
    }

    e.preventDefault();
    sec.el.setPointerCapture(e.pointerId);

    const sel = this.selection;
    if (sel && sel.sectionId === sec.id && inBox(sel.box, x, y, 12)) {
      const strokes = sec.strokes().filter((s) => sel.ids.has(s.id));
      this.gesture = { type: "drag", sec, rect, start: [x, y], dx: 0, dy: 0, strokes, pointerId: e.pointerId };
      this.cb.onDragging(sel.ids);
      this.requestFrame();
      return;
    }
    if (sel) this.setSelection(null);

    if (kind === "eraser") {
      const g: Gesture = { type: "erase", sec, rect, last: [x, y], at: [x, y], erased: new Set(), pointerId: e.pointerId };
      this.gesture = g;
      this.eraseAlong(g, x, y);
    } else if (kind === "lasso") {
      this.gesture = { type: "lasso", sec, rect, poly: [[x, y]], pointerId: e.pointerId };
    } else {
      const hl = kind === "highlighter";
      const data: StrokeData = {
        tool: hl ? "highlighter" : "pen",
        color: hl ? this.tool.hlColor : this.tool.penColor,
        size: hl ? this.tool.hlSize : this.tool.penSize,
        pts: [],
        t0: Date.now(),
        input: e.pointerType,
        device: deviceId(),
      };
      this.gesture = { type: "ink", sec, rect, data, predicted: [], t0: e.timeStamp, pointerId: e.pointerId };
      this.addPoints(this.gesture, [e]);
    }
    this.requestFrame();
  }

  move(e: PointerEvent, sec: SectionHandle) {
    const g = this.gesture;
    if (!g) {
      if (e.pointerType === "pen" && e.buttons === 0) {
        const rect = sec.el.getBoundingClientRect();
        const [x, y] = this.local(e, rect);
        this.hover = { sec, x, y };
        this.requestFrame();
      }
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    const evs = events.length ? events : [e];

    if (g.type === "ink") {
      this.addPoints(g, evs);
      const predicted = e.getPredictedEvents?.() ?? [];
      g.predicted = [];
      for (const p of predicted) {
        const [x, y] = this.local(p, g.rect);
        g.predicted.push(x, y, p.pressure || 0.5, 0, 0, 0);
      }
    } else if (g.type === "erase") {
      for (const ev of evs) {
        const [x, y] = this.local(ev, g.rect);
        this.eraseAlong(g, x, y);
      }
    } else if (g.type === "lasso") {
      for (const ev of evs) g.poly.push(this.local(ev, g.rect));
    } else if (g.type === "drag") {
      const [x, y] = this.local(e, g.rect);
      g.dx = x - g.start[0];
      g.dy = y - g.start[1];
    }
    this.requestFrame();
  }

  up(e: PointerEvent) {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    if (e.type !== "pointercancel" && g.type === "ink") this.addPoints(g, [e]);

    if (g.type === "ink") void this.commitInk(g);
    else if (g.type === "erase") this.commitErase(g);
    else if (g.type === "lasso") this.commitLasso(g);
    else if (g.type === "drag") void this.commitDrag(g);
    this.requestFrame();
  }

  leave() {
    if (this.hover) {
      this.hover = null;
      this.requestFrame();
    }
  }

  async deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const ids = [...sel.ids];
    this.setSelection(null);
    await setDeleted(ids, true);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "delete", undo: () => setDeleted(ids, false), redo: () => setDeleted(ids, true) });
    void logEvent(this.notebookId, sel.sectionId, "lasso_delete", { ids });
  }

  private addPoints(g: Extract<Gesture, { type: "ink" }>, evs: PointerEvent[]) {
    const pts = g.data.pts;
    for (const ev of evs) {
      const [x, y] = this.local(ev, g.rect);
      const n = pts.length;
      // Drop exact duplicates (pointerup often repeats the last move).
      if (n && pts[n - 6] === round(x, 100) && pts[n - 5] === round(y, 100)) continue;
      const pressure = ev.pointerType === "pen" ? ev.pressure : 0.5;
      pts.push(
        round(x, 100),
        round(y, 100),
        round(pressure, 1000),
        round(ev.altitudeAngle ?? Math.PI / 2, 1000),
        round(ev.azimuthAngle ?? 0, 1000),
        Math.max(0, Math.round(ev.timeStamp - g.t0)),
      );
    }
  }

  private async commitInk(g: Extract<Gesture, { type: "ink" }>) {
    if (!g.data.pts.length) return;
    const stroke = newEntity<"stroke", StrokeData>("stroke", this.notebookId, g.sec.id, g.data);
    const path = strokePath(g.data);
    this.pending.set(stroke.id, { data: g.data, path, sec: g.sec, until: performance.now() + 1500 });
    const [saved] = await putEntities([stroke]);
    seedPath(saved, path);
    const id = stroke.id;
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "stroke", undo: () => setDeleted([id], true), redo: () => setDeleted([id], false) });
    const n = g.data.pts.length / STROKE_STRIDE;
    void logEvent(this.notebookId, g.sec.id, "stroke", {
      id,
      tool: g.data.tool,
      points: n,
      durationMs: g.data.pts[g.data.pts.length - 1],
      box: dataBox(g.data),
    });
  }

  private eraseAlong(g: Extract<Gesture, { type: "erase" }>, x: number, y: number) {
    const candidates = g.sec.strokes().filter((s) => !g.erased.has(s.id));
    const hits = hitStrokes(candidates, g.last[0], g.last[1], x, y, this.tool.eraserSize / 2);
    g.last = [x, y];
    g.at = [x, y];
    if (!hits.length) return;
    const ids = hits.map((h) => h.id);
    ids.forEach((id) => g.erased.add(id));
    void setDeleted(ids, true);
  }

  private commitErase(g: Extract<Gesture, { type: "erase" }>) {
    if (!g.erased.size) return;
    const ids = [...g.erased];
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "erase", undo: () => setDeleted(ids, false), redo: () => setDeleted(ids, true) });
    void logEvent(this.notebookId, g.sec.id, "erase", { ids });
  }

  private commitLasso(g: Extract<Gesture, { type: "lasso" }>) {
    const picked = lassoStrokes(g.sec.strokes(), g.poly);
    if (!picked.length) return;
    const box = unionBox(picked.map(strokeBox))!;
    this.setSelection({ sectionId: g.sec.id, ids: new Set(picked.map((s) => s.id)), box });
  }

  private async commitDrag(g: Extract<Gesture, { type: "drag" }>) {
    const { dx, dy, strokes } = g;
    const sel = this.selection;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.cb.onDragging(null);
      return;
    }
    await moveStrokes(strokes, dx, dy);
    this.cb.onDragging(null);
    if (sel) this.setSelection({ ...sel, box: shift(sel.box, dx, dy) });
    const ids = strokes.map((s) => s.id);
    const current = async (ddx: number, ddy: number) => {
      const rows = (await db.entities.bulkGet(ids)).filter(Boolean) as StrokeEntity[];
      await moveStrokes(rows, ddx, ddy);
    };
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "move", undo: () => current(-dx, -dy), redo: () => current(dx, dy) });
    void logEvent(this.notebookId, g.sec.id, "lasso_move", { ids, dx, dy });
  }

  requestFrame() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const ctx = this.ctx;
    const canvas = this.live;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Section rects are in client coordinates; the overlay is not always at (0, 0) on iOS (e.g.
    // while the keyboard shifts the visual viewport).
    const origin = this.gesture || this.pending.size || this.hover ? canvas.getBoundingClientRect() : null;

    const toSection = (rect: DOMRect) => {
      ctx.setTransform(dpr * this.zoom, 0, 0, dpr * this.zoom, dpr * (rect.left - origin!.left), dpr * (rect.top - origin!.top));
    };

    const now = performance.now();
    for (const [id, p] of this.pending) {
      if (now > p.until) {
        this.pending.delete(id);
        continue;
      }
      toSection(p.sec.el.getBoundingClientRect());
      paintStroke(ctx, p.data, p.path);
    }
    if (this.pending.size) this.requestFrame();

    const g = this.gesture;
    if (g?.type === "ink" && g.data.pts.length) {
      toSection(g.rect);
      const data = g.predicted.length ? { ...g.data, pts: g.data.pts.concat(g.predicted) } : g.data;
      paintStroke(ctx, data, strokePath(data, false));
    } else if (g?.type === "erase") {
      toSection(g.rect);
      ctx.beginPath();
      ctx.arc(g.at[0], g.at[1], this.tool.eraserSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(100,116,139,0.8)";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.stroke();
    } else if (g?.type === "lasso") {
      toSection(g.rect);
      ctx.beginPath();
      g.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.setLineDash([6 / this.zoom, 5 / this.zoom]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g?.type === "drag") {
      toSection(g.rect);
      ctx.translate(g.dx, g.dy);
      for (const s of g.strokes) paintStroke(ctx, s.data, cachedPath(s));
    }

    if (!g && this.hover) {
      const h = this.hover;
      toSection(h.sec.el.getBoundingClientRect());
      const k = this.tool.kind;
      const r = k === "eraser" ? this.tool.eraserSize / 2 : k === "highlighter" ? this.tool.hlSize / 2 : Math.max(this.tool.penSize / 2, 1.5);
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      if (k === "pen") {
        ctx.fillStyle = this.tool.penColor + "99";
        ctx.fill();
      } else {
        ctx.strokeStyle = "rgba(100,116,139,0.8)";
        ctx.lineWidth = 1 / this.zoom;
        ctx.stroke();
      }
    }
  }
}

function inBox(b: Box, x: number, y: number, pad: number) {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}

function shift(b: Box, dx: number, dy: number): Box {
  return { minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy };
}
