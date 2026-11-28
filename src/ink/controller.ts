import { emitActivity, setInking, whenIdle } from "@/lib/activity";
import { renderFlag } from "@/lib/render-flags";
import { db, deviceId } from "@/lib/db";
import { logEvent, moveStrokes, newEntity, putEntities, setDeleted } from "@/lib/store";
import { cropImage, imageBox, imageElement, lassoImages, placeImage } from "@/lib/page-images";
import { PAGE_WIDTH, STROKE_STRIDE, type ImageData, type ImageEntity, type StrokeData, type StrokeEntity } from "@/lib/types";
import { isStrayDot, type Contact } from "./filters";
import { dataBox, hitStrokes, lassoStrokes, strokeBox, unionBox, type Box, type LassoMode } from "./geometry";
import { penOverrides, withOverrides, type PenParams } from "./pen-feel";
import { paintStroke, strokePath, cachedPath, seedPath } from "./render";
import { appendPoint, toLocal } from "./samples";
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
  /** Pen parameters changed from the defaults (pen-feel.ts). */
  pen?: Partial<PenParams>;
  /** Quick pen feel from before `pen` existed; read once to migrate saved tool state. */
  penSmoothing?: number;
  penSensitivity?: number;
}

/**
 * The parts of a PointerEvent the controller reads. Live input passes the browser's PointerEvent;
 * replay (replay.ts) passes plain objects built from a recording, so recorded writing goes through
 * exactly the same processing without synthesising DOM events.
 */
export interface InkPointer {
  type: string;
  pointerType: string;
  pointerId: number;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  preventDefault(): void;
  getCoalescedEvents?(): InkPointer[];
  getPredictedEvents?(): InkPointer[];
}

/** Which controller entry point an input reached: the page surface or the selection's grab box. */
export type InputKind = "down" | "move" | "up" | "lost" | "grab";

export interface SectionHandle {
  id: string;
  el: HTMLElement;
  strokes: () => StrokeEntity[];
  /** Pictures on the page (src/lib/page-images.ts); none where the page has no images. */
  images?: () => ImageEntity[];
}

export interface Selection {
  sectionId: string;
  /** Strokes and pictures. */
  ids: Set<string>;
  box: Box;
  /** A rectangle lasso's rectangle: it stays selected with or without ink in it. */
  area?: Box;
  /** The rectangle around what was drawn (the free lasso's loop, or the rectangle): what Copy
   *  image takes and Crop keeps. */
  bounds?: Box;
}

/** Copied strokes and pictures (section units), to paste elsewhere (Copy, ⌘C). */
export interface InkClip {
  strokes: StrokeData[];
  images: ImageData[];
  box: Box;
}

/** How the lasso is drawn: a free loop, or a rectangle from where it started to where it is. */
export type LassoShape = "free" | "rect";

type Gesture =
  | { type: "ink"; sec: SectionHandle; rect: DOMRect; data: StrokeData; predicted: number[]; t0: number; contact: Contact; pointerId: number }
  | { type: "erase"; sec: SectionHandle; rect: DOMRect; last: [number, number]; erased: Set<string>; at: [number, number]; pointerId: number }
  | { type: "lasso"; sec: SectionHandle; rect: DOMRect; poly: number[][]; pointerId: number }
  | { type: "drag"; sec: SectionHandle; rect: DOMRect; start: [number, number]; dx: number; dy: number; strokes: StrokeEntity[]; images: ImageEntity[]; pointerId: number };

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
  /** Every input as it reaches the controller, before any filtering (the Pencil recorder). */
  onInput?: (kind: InputKind, e: InkPointer, sec: SectionHandle) => void;
  /** A pen or highlighter stroke that passed the filters, as it is committed. */
  onCommit?: (sectionId: string, data: StrokeData, id: string) => void;
  /** A pen or highlighter gesture the stray-dot filter threw away (replay reports count them). */
  onDiscard?: (sectionId: string, data: StrokeData) => void;
}

export interface ControllerOptions {
  /** False keeps strokes out of the notebook store, undo and the event log (Pencil lab, tests). */
  persist?: boolean;
  /** Wall clock for StrokeData.t0; replay passes the recorded time so output is deterministic. */
  now?: () => number;
  /** StrokeData.device for new strokes (default: this browser's deviceId); replay fixes it. */
  device?: string;
}

const round = (v: number, f: number) => Math.round(v * f) / f;

/** The pointerId of a lasso drawn by a held finger: fed from touch events, it matches no pointer. */
export const FINGER_LASSO = -1;

export class InkController {
  tool: ToolState;
  zoom = 1;
  notebookId: string;
  readonly undo = new UndoStack();
  /** How the lasso picks strokes (Settings → Lasso). */
  private lassoMode: LassoMode = "touch";
  private lassoShape: LassoShape = "free";
  /** What Copy or ⌘C took, kept while the page is open (any notebook). */
  static clipboard: InkClip | null = null;

  setLassoShape(shape: LassoShape) {
    this.lassoShape = shape;
  }

  setLassoMode(mode: LassoMode) {
    this.lassoMode = mode;
  }
  /** The tool's pen parameters, and the part of them new pen strokes store. */
  private pen!: PenParams;
  private penOverrides!: Partial<PenParams>;
  selection: Selection | null = null;

  private live: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private gesture: Gesture | null = null;
  private hover: { sec: SectionHandle; x: number; y: number } | null = null;
  private pending = new Map<string, Pending>();
  private frame = 0;
  // The overlay is a full-window bitmap (22-29 MB); it only has one while something is on it.
  private liveSized = false;
  private liveRelease: ReturnType<typeof setTimeout> | null = null;
  private cb: ControllerCallbacks;
  private persist: boolean;
  private now: () => number;
  private device: string | undefined;
  private unsaved = 0;
  /** Mounted sections, so a finger lasso can find the one under the finger. */
  private sections = new Set<SectionHandle>();

  constructor(notebookId: string, tool: ToolState, cb: ControllerCallbacks, opts: ControllerOptions = {}) {
    this.notebookId = notebookId;
    this.tool = tool;
    this.setPen(tool);
    this.cb = cb;
    this.persist = opts.persist ?? true;
    this.now = opts.now ?? Date.now;
    this.device = opts.device;
  }

  configure(tool: ToolState, zoom: number) {
    if (tool.pen !== this.tool.pen) this.setPen(tool);
    this.tool = tool;
    this.zoom = zoom;
  }

  attachLive(canvas: HTMLCanvasElement | null) {
    if (this.live && this.live !== canvas) {
      this.live.width = 0;
      this.live.height = 0;
    }
    if (this.liveRelease) clearTimeout(this.liveRelease);
    this.liveRelease = null;
    this.liveSized = !renderFlag("lazyOverlay");
    if (!canvas) {
      // The editor is going away mid-stroke: keep what was drawn (sections end it too, but their
      // cleanup runs after this ref is detached and would find the gesture already cleared).
      if (this.gesture) this.end(this.gesture, null);
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.pending.clear();
      this.setGesture(null);
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
    if (this.liveSized) {
      this.live.width = Math.round(w * dpr);
      this.live.height = Math.round(h * dpr);
    }
    this.requestFrame();
  }

  /** Gives the overlay its bitmap: first Pencil hover, press or pending stroke after a quiet spell. */
  private wakeLive() {
    if (this.liveRelease) clearTimeout(this.liveRelease);
    this.liveRelease = null;
    if (this.liveSized || !this.live) return;
    this.liveSized = true;
    this.resizeLive();
  }

  /** Frees the overlay's bitmap once nothing has been on it for a while. */
  private releaseLiveLater() {
    if (!this.liveSized || this.liveRelease || !renderFlag("lazyOverlay")) return;
    this.liveRelease = setTimeout(() => {
      this.liveRelease = null;
      if (this.gesture || this.pending.size || this.hover || !this.live) return;
      this.liveSized = false;
      this.live.width = 0;
      this.live.height = 0;
    }, 20_000);
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

  private local(e: InkPointer, rect: DOMRect): [number, number] {
    return toLocal(e.clientX, e.clientY, rect, this.zoom);
  }

  private accepts(e: InkPointer) {
    if (e.pointerType === "touch") return false;
    if (e.pointerType === "mouse" && e.button !== 0) return false;
    return true;
  }

  private setPen(tool: ToolState) {
    this.pen = withOverrides(tool.pen);
    this.penOverrides = penOverrides(this.pen);
  }

  private setGesture(g: Gesture | null) {
    this.gesture = g;
    setInking(g !== null);
  }

  down(e: InkPointer, sec: SectionHandle) {
    this.cb.onInput?.("down", e, sec);
    if (!this.accepts(e)) return;
    // A new pointerdown while a gesture is open means the old pointer's pointerup/pointercancel
    // never reached us (capture lost, Scribble, a system gesture). Finish it and take the new one;
    // ignoring it here is what left the Pencil dead until reload.
    if (this.gesture) this.end(this.gesture, null);
    const rect = sec.el.getBoundingClientRect();
    const [x, y] = this.local(e, rect);
    this.hover = null;
    const kind = this.tool.kind;

    if (kind === "text") {
      this.cb.onTextCreate(sec.id, x, y);
      return;
    }

    e.preventDefault();
    try {
      sec.el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (WebKit can deliver a stale pointerdown); still draw.
    }

    const sel = this.selection;
    if (sel && sel.sectionId === sec.id && inBox(sel.box, x, y, 12)) {
      this.startDrag(sec, rect, x, y, e.pointerId);
      return;
    }
    if (sel) this.setSelection(null);

    if (kind === "eraser") {
      const g: Gesture = { type: "erase", sec, rect, last: [x, y], at: [x, y], erased: new Set(), pointerId: e.pointerId };
      this.setGesture(g);
      this.eraseAlong(g, x, y);
    } else if (kind === "lasso") {
      this.setGesture({ type: "lasso", sec, rect, poly: [[x, y]], pointerId: e.pointerId });
    } else {
      const hl = kind === "highlighter";
      const data: StrokeData = {
        tool: hl ? "highlighter" : "pen",
        color: hl ? this.tool.hlColor : this.tool.penColor,
        size: hl ? this.tool.hlSize : this.tool.penSize,
        pts: [],
        t0: this.now(),
        input: e.pointerType,
        device: this.device ?? deviceId(),
        ...(hl || !Object.keys(this.penOverrides).length ? {} : { pen: this.penOverrides }),
      };
      const g: Extract<Gesture, { type: "ink" }> = { type: "ink", sec, rect, data, predicted: [], t0: e.timeStamp, contact: { durationMs: 0, maxPressure: 0 }, pointerId: e.pointerId };
      this.setGesture(g);
      this.addPoints(g, [e]);
    }
    this.requestFrame();
  }

  move(e: InkPointer, sec: SectionHandle) {
    this.cb.onInput?.("move", e, sec);
    let g = this.gesture;
    // The pointer is hovering with nothing pressed: its pointerup was lost. End the gesture.
    if (g && e.pointerId === g.pointerId && e.buttons === 0) {
      this.end(g, null);
      g = null;
    }
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
      // Only the nearest predictions are used: far ones overshoot on direction changes and at the
      // stroke end, where the line then visibly retracts when the prediction is dropped.
      const predicted = (e.getPredictedEvents?.() ?? []).slice(0, this.pen.maxPredicted);
      const pts = g.data.pts;
      // Predictions carry the last real pressure and time, so they can't change the line's width.
      const lastP = pts[pts.length - 4];
      const lastT = pts[pts.length - 1];
      g.predicted = [];
      for (const p of predicted) {
        const [x, y] = this.local(p, g.rect);
        g.predicted.push(round(x, 100), round(y, 100), lastP, 0, 0, lastT);
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
      [g.dx, g.dy] = this.selection ? clampMove(this.selection.box, x - g.start[0], y - g.start[1], g.rect.height / this.zoom) : [x - g.start[0], y - g.start[1]];
    }
    this.requestFrame();
  }

  /**
   * Starts moving the selection from a press on its box. Unlike drawing, any pointer may do this,
   * a finger included, so on the iPad the selection can be dragged by hand.
   */
  grab(e: InkPointer, sec: SectionHandle, target: Pick<Element, "setPointerCapture">) {
    this.cb.onInput?.("grab", e, sec);
    const sel = this.selection;
    if (!sel || sel.sectionId !== sec.id) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (this.gesture) this.end(this.gesture, null);
    e.preventDefault();
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; the drag still follows any moves that arrive.
    }
    const rect = sec.el.getBoundingClientRect();
    const [x, y] = this.local(e, rect);
    this.hover = null;
    this.startDrag(sec, rect, x, y, e.pointerId);
  }

  private startDrag(sec: SectionHandle, rect: DOMRect, x: number, y: number, pointerId: number) {
    const sel = this.selection!;
    const strokes = sec.strokes().filter((s) => sel.ids.has(s.id));
    const images = (sec.images?.() ?? []).filter((s) => sel.ids.has(s.id));
    this.setGesture({ type: "drag", sec, rect, start: [x, y], dx: 0, dy: 0, strokes, images, pointerId });
    this.cb.onDragging(sel.ids);
    this.requestFrame();
  }

  up(e: InkPointer, sec?: SectionHandle) {
    if (sec) this.cb.onInput?.("up", e, sec);
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.end(g, e.type === "pointercancel" ? null : e);
  }

  /** Capture was taken away mid-gesture (element detached, system gesture): the up may never come. */
  lostCapture(e: InkPointer, sec: SectionHandle) {
    this.cb.onInput?.("lost", e, sec);
    const g = this.gesture;
    // Only the gesture's own section: a stale gesture's section losing capture to a new stroke with
    // the same pointerId must not end that new stroke.
    if (g && e.pointerId === g.pointerId && sec.id === g.sec.id) this.end(g, null);
  }

  /** Adds a mounted section; returns the call that removes it. */
  registerSection(sec: SectionHandle) {
    this.sections.add(sec);
    return () => void this.sections.delete(sec);
  }

  /** A mounted section by id (the lasso circle's Duplicate needs the selection's section). */
  sectionById(id: string) {
    for (const sec of this.sections) if (sec.id === id) return sec;
    return null;
  }

  private sectionAt(clientX: number, clientY: number) {
    for (const sec of this.sections) {
      const el = sec.el as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      if (r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return sec;
    }
    return null;
  }

  /**
   * Starts a lasso from a finger press and hold, whatever the tool. Fingers never reach down()
   * (they scroll), so the editor feeds it from touch events: extendFingerLasso as the finger moves,
   * endFingerLasso when it lifts. False when there is no page under the finger or the Pencil is busy.
   */
  beginFingerLasso(clientX: number, clientY: number) {
    if (this.gesture) return false;
    const sec = this.sectionAt(clientX, clientY);
    if (!sec) return false;
    const rect = sec.el.getBoundingClientRect();
    this.hover = null;
    if (this.selection) this.setSelection(null);
    this.setGesture({ type: "lasso", sec, rect, poly: [toLocal(clientX, clientY, rect, this.zoom)], pointerId: FINGER_LASSO });
    this.requestFrame();
    return true;
  }

  extendFingerLasso(clientX: number, clientY: number) {
    const g = this.gesture;
    if (g?.type !== "lasso" || g.pointerId !== FINGER_LASSO) return;
    g.poly.push(toLocal(clientX, clientY, g.rect, this.zoom));
    this.requestFrame();
  }

  /** Lifting selects what the lasso circled; `cancel` (a second finger, say) drops it instead. */
  endFingerLasso(cancel = false) {
    const g = this.gesture;
    if (g?.type !== "lasso" || g.pointerId !== FINGER_LASSO) return;
    if (!cancel) return this.end(g, null);
    this.setGesture(null);
    this.requestFrame();
  }

  /** Ends the open gesture, keeping what was drawn: page hidden, window blurred, section unmounted. */
  endGesture(sectionId?: string) {
    const g = this.gesture;
    if (g && (!sectionId || g.sec.id === sectionId)) this.end(g, null);
  }

  private end(g: Gesture, last: InkPointer | null) {
    if (this.gesture === g) this.setGesture(null);
    if (last && g.type === "ink") this.addPoints(g, [last]);

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

  /**
   * Copies the selected strokes a little down and to the right (kept on the page) and selects the
   * copy, so it can be dragged straight into place: rewriting a line of working, a repeated diagram.
   */
  async duplicateSelection(sec: SectionHandle) {
    const sel = this.selection;
    if (!sel || sel.sectionId !== sec.id || !this.persist) return;
    const originals = sec.strokes().filter((s) => sel.ids.has(s.id));
    const pictures = (sec.images?.() ?? []).filter((s) => sel.ids.has(s.id));
    if (!originals.length && !pictures.length) return;
    const height = sec.el.getBoundingClientRect().height / this.zoom;
    const [dx, dy] = clampMove(sel.box, DUPLICATE_OFFSET, DUPLICATE_OFFSET, height);
    // Strokes paint in t0 order, so the copies take times just up to now, in their originals'
    // order: kept as they were, they would paint under everything drawn since.
    const now = this.now();
    const copies = originals
      .sort((a, b) => a.data.t0 - b.data.t0)
      .map((s, i, all) => newEntity<"stroke", StrokeData>("stroke", this.notebookId, sec.id, { ...s.data, t0: now - (all.length - 1 - i), pts: shiftPts(s.data.pts, dx, dy) }));
    const pictureCopies = pictures.map((s) => newEntity<"image", ImageData>("image", this.notebookId, sec.id, { ...s.data, x: s.data.x + dx, y: s.data.y + dy }));
    await putEntities([...pictureCopies, ...copies]);
    const ids = [...copies, ...pictureCopies].map((s) => s.id);
    const copySel = { sectionId: sec.id, ids: new Set(ids), box: shift(sel.box, dx, dy), area: sel.area && shift(sel.area, dx, dy), bounds: sel.bounds && shift(sel.bounds, dx, dy) };
    this.setSelection(copySel);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({
      label: "duplicate",
      undo: async () => {
        // The copy's box would be left framing nothing.
        if (this.selection?.ids === copySel.ids) this.setSelection(null);
        await setDeleted(ids, true);
      },
      redo: () => setDeleted(ids, false),
    });
    void logEvent(this.notebookId, sec.id, "lasso_duplicate", { from: [...sel.ids], ids, dx, dy });
  }

  /** Copies the selected strokes and pictures (Copy, ⌘C); false when nothing is selected. */
  copySelection() {
    const sel = this.selection;
    const sec = sel && this.sectionById(sel.sectionId);
    if (!sel || !sec) return false;
    const strokes = sec.strokes().filter((s) => sel.ids.has(s.id)).sort((a, b) => a.data.t0 - b.data.t0).map((s) => s.data);
    const images = (sec.images?.() ?? []).filter((s) => sel.ids.has(s.id)).map((s) => s.data);
    if (!strokes.length && !images.length) return false;
    InkController.clipboard = { strokes, images, box: sel.box };
    return true;
  }

  /** Pastes what was copied centred on (x, y), kept on the page's width, selected so it can be
   *  moved straight away. One undoable step. */
  async pasteClip(sec: SectionHandle, x: number, y: number) {
    const clip = InkController.clipboard;
    if (!clip || !this.persist) return;
    const w = clip.box.maxX - clip.box.minX, h = clip.box.maxY - clip.box.minY;
    const dx = Math.min(Math.max(x, w / 2), Math.max(w / 2, PAGE_WIDTH - w / 2)) - (clip.box.minX + w / 2);
    const dy = Math.max(y, h / 2) - (clip.box.minY + h / 2);
    const now = this.now();
    const strokes = clip.strokes.map((d, i, all) => newEntity<"stroke", StrokeData>("stroke", this.notebookId, sec.id, { ...d, t0: now - (all.length - 1 - i), pts: shiftPts(d.pts, dx, dy) }));
    const images = clip.images.map((d) => newEntity<"image", ImageData>("image", this.notebookId, sec.id, { ...d, x: d.x + dx, y: d.y + dy }));
    await putEntities([...images, ...strokes]);
    const ids = [...strokes, ...images].map((s) => s.id);
    const pasted = { sectionId: sec.id, ids: new Set(ids), box: shift(clip.box, dx, dy) };
    this.setSelection(pasted);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({
      label: "paste",
      undo: async () => {
        if (this.selection?.ids === pasted.ids) this.setSelection(null);
        await setDeleted(ids, true);
      },
      redo: () => setDeleted(ids, false),
    });
    void logEvent(this.notebookId, sec.id, "lasso_paste", { ids, dx, dy });
  }

  /** Selected pictures reaching outside the drawn rectangle, with the part of each to keep. */
  croppable(): { row: ImageEntity; keep: Box }[] {
    const sel = this.selection;
    const box = sel?.area ?? sel?.bounds;
    const sec = sel && this.sectionById(sel.sectionId);
    if (!sel || !box || !sec) return [];
    return (sec.images?.() ?? []).flatMap((row) => {
      if (!sel.ids.has(row.id)) return [];
      const f = imageBox(row.data);
      const keep = { minX: Math.max(f.minX, box.minX), minY: Math.max(f.minY, box.minY), maxX: Math.min(f.maxX, box.maxX), maxY: Math.min(f.maxY, box.maxY) };
      const same = Math.round(keep.minX) === Math.round(f.minX) && Math.round(keep.minY) === Math.round(f.minY) && Math.round(keep.maxX) === Math.round(f.maxX) && Math.round(keep.maxY) === Math.round(f.maxY);
      return keep.maxX - keep.minX >= 8 && keep.maxY - keep.minY >= 8 && !same ? [{ row, keep }] : [];
    });
  }

  /** Cuts each selected picture down to the part inside the drawn rectangle, as one undoable step. */
  async cropSelection() {
    const sel = this.selection;
    if (!sel || !this.persist) return 0;
    const cuts = await Promise.all(
      this.croppable().map(async ({ row, keep }) => {
        const src = await cropImage(row.data, keep);
        return src ? { row, data: { ...row.data, src, x: Math.round(keep.minX), y: Math.round(keep.minY), w: Math.round(keep.maxX - keep.minX), h: Math.round(keep.maxY - keep.minY) } } : null;
      }),
    );
    const done = cuts.filter((c): c is NonNullable<typeof c> => !!c);
    if (!done.length) return 0;
    const write = async (to: (c: (typeof done)[number]) => ImageData) => {
      const rows = (await db.entities.bulkGet(done.map((c) => c.row.id))) as (ImageEntity | undefined)[];
      await putEntities(done.flatMap((c, i) => (rows[i] ? [{ ...rows[i]!, data: to(c) }] : [])));
      await this.refreshSelectionBox();
    };
    await write((c) => c.data);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "crop", undo: () => write((c) => c.row.data), redo: () => write((c) => c.data) });
    void logEvent(this.notebookId, sel.sectionId, "image_crop", { ids: done.map((c) => c.row.id) });
    return done.length;
  }

  /**
   * Puts a picture (an encoded clipboard image) on the page centred on (x, y), selected so it can
   * be moved or resized straight away. One undoable step.
   */
  async pasteImage(sec: SectionHandle, x: number, y: number, picture: { src: string; width: number; height: number }) {
    if (!this.persist) return;
    const row = newEntity<"image", ImageData>("image", this.notebookId, sec.id, { ...placeImage(picture.width, picture.height, x, y), src: picture.src });
    await putEntities([row]);
    const pasted = { sectionId: sec.id, ids: new Set([row.id]), box: imageBox(row.data) };
    this.setSelection(pasted);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({
      label: "paste",
      undo: async () => {
        if (this.selection?.ids === pasted.ids) this.setSelection(null);
        await setDeleted([row.id], true);
      },
      redo: () => setDeleted([row.id], false),
    });
    void logEvent(this.notebookId, sec.id, "image_paste", { id: row.id, w: row.data.w, h: row.data.h });
  }

  /** Gives the selected strokes one colour, as one undoable step. */
  recolorSelection(color: string) {
    return this.restyleSelection("recolour", () => ({ color }));
  }

  /**
   * Scales the selection by `k` about its centre, line widths too, as one undoable step. A box
   * that would cross the page's left, right or top edge is moved back onto the page.
   */
  scaleSelection(factor: number) {
    const sel = this.selection;
    if (!sel) return;
    // Never wider than the page: past that the ink would be clipped wherever it was moved.
    const width = sel.box.maxX - sel.box.minX;
    const k = factor > 1 && width > 0 ? Math.max(1, Math.min(factor, PAGE_WIDTH / width)) : factor;
    if (k === 1) return;
    const cx = (sel.box.minX + sel.box.maxX) / 2;
    const cy = (sel.box.minY + sel.box.maxY) / 2;
    const scaled = { minX: cx + (sel.box.minX - cx) * k, maxX: cx + (sel.box.maxX - cx) * k, minY: cy + (sel.box.minY - cy) * k, maxY: cy + (sel.box.maxY - cy) * k };
    const dx = scaled.minX < 0 ? -scaled.minX : scaled.maxX > PAGE_WIDTH ? Math.max(-scaled.minX, PAGE_WIDTH - scaled.maxX) : 0;
    const dy = scaled.minY < 0 ? -scaled.minY : 0;
    // The drawn rectangle grows and shrinks with what it holds.
    const scaleBox = (b?: Box) => b && { minX: cx + (b.minX - cx) * k + dx, maxX: cx + (b.maxX - cx) * k + dx, minY: cy + (b.minY - cy) * k + dy, maxY: cy + (b.maxY - cy) * k + dy };
    if (sel.area || sel.bounds) this.setSelection({ ...sel, area: scaleBox(sel.area), bounds: scaleBox(sel.bounds) });
    return this.restyleSelection(
      k > 1 ? "enlarge" : "shrink",
      (d) => {
        const pts = d.pts.slice();
        for (let i = 0; i < pts.length; i += STROKE_STRIDE) {
          pts[i] = cx + (pts[i] - cx) * k + dx;
          pts[i + 1] = cy + (pts[i + 1] - cy) * k + dy;
        }
        return { pts, size: d.size * k };
      },
      (d) => ({ x: cx + (d.x - cx) * k + dx, y: cy + (d.y - cy) * k + dy, w: d.w * k, h: d.h * k }),
    );
  }

  /**
   * Changes some fields of the selected strokes (`patchOf` returns just those) as one undoable
   * step. Undo and redo touch only those fields, and only on strokes that still hold what the step
   * left: an edit made since (a move synced from the Mac, say) is kept, not rolled back.
   */
  private async restyleSelection(label: string, patchOf: (d: StrokeData) => Partial<StrokeData>, imagePatchOf?: (d: ImageData) => Partial<ImageData>) {
    const sel = this.selection;
    if (!sel || !this.persist) return;
    // Pictures change only with their own patch (a recolour leaves them be).
    const rows = (await db.entities.bulkGet([...sel.ids])).filter(
      (r): r is StrokeEntity | ImageEntity => !!r && !r.deleted && (r.kind === "stroke" || (r.kind === "image" && !!imagePatchOf)),
    );
    if (!rows.length) return;
    type Fields = Record<string, unknown>;
    const patch = (r: StrokeEntity | ImageEntity): Fields => (r.kind === "image" ? imagePatchOf!(r.data) : patchOf(r.data));
    const after = new Map(rows.map((r) => [r.id, patch(r)]));
    const before = new Map(rows.map((r) => [r.id, pick(r.data as unknown as Fields, Object.keys(after.get(r.id)!))]));
    const apply = async (from: Map<string, Fields>, to: Map<string, Fields>) => {
      const now = (await db.entities.bulkGet([...to.keys()])).filter((r) => !!r && holds(r.data as Fields, from.get(r.id)!));
      if (now.length) await putEntities(now.map((r) => ({ ...r!, data: { ...(r!.data as Fields), ...to.get(r!.id)! } })));
      await this.refreshSelectionBox();
    };
    await apply(before, after);
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label, undo: () => apply(after, before), redo: () => apply(before, after) });
    void logEvent(this.notebookId, sel.sectionId, `lasso_${label}`, { ids: [...sel.ids] });
  }

  /** Fits the selection box to its strokes and pictures as stored now, after an edit, undo or redo moved them. */
  private async refreshSelectionBox() {
    const sel = this.selection;
    if (!sel) return;
    const rows = (await db.entities.bulkGet([...sel.ids])).filter((r): r is StrokeEntity | ImageEntity => !!r && !r.deleted && (r.kind === "stroke" || r.kind === "image"));
    const box = unionBox([...rows.map((r) => (r.kind === "image" ? imageBox(r.data) : dataBox(r.data))), ...(sel.area ? [sel.area] : [])]);
    // Only if it is still the same selection once the rows have been read.
    if (box && this.selection === sel) this.setSelection({ ...sel, box });
  }

  private addPoints(g: Extract<Gesture, { type: "ink" }>, evs: InkPointer[]) {
    const pts = g.data.pts;
    for (const ev of evs) {
      // Tracked for every event, stored or not: a held dot has duplicate points but real duration.
      g.contact.durationMs = Math.max(g.contact.durationMs, ev.timeStamp - g.t0);
      if (ev.pointerType === "pen") g.contact.maxPressure = Math.max(g.contact.maxPressure, ev.pressure);
      const [x, y] = this.local(ev, g.rect);
      appendPoint(pts, x, y, ev, g.t0, this.pen.dropOutOfOrder);
    }
  }

  private async commitInk(g: Extract<Gesture, { type: "ink" }>) {
    if (!g.data.pts.length) return;
    // Pencil bounce, a resting tip or a cancelled Scribble touch: not ink.
    if (isStrayDot(g.data, g.contact, this.pen)) {
      this.cb.onDiscard?.(g.sec.id, g.data);
      return;
    }
    if (!this.persist) {
      // Not stored: the host paints it (and acks the id) or only inspects it.
      const id = `unsaved-${++this.unsaved}`;
      this.cb.onCommit?.(g.sec.id, g.data, id);
      // With no overlay (headless replay) there is nothing to paint, and no Path2D to build.
      if (this.live) this.pending.set(id, { data: g.data, path: strokePath(g.data), sec: g.sec, until: performance.now() + 1500 });
      return;
    }
    const stroke = newEntity<"stroke", StrokeData>("stroke", this.notebookId, g.sec.id, g.data);
    this.cb.onCommit?.(g.sec.id, g.data, stroke.id);
    const path = strokePath(g.data);
    this.pending.set(stroke.id, { data: g.data, path, sec: g.sec, until: performance.now() + 1500 });
    const [saved] = await putEntities([stroke]);
    seedPath(saved, path);
    const id = stroke.id;
    // The layout re-renders the whole editor on activity; let the next stroke start first.
    const at = Date.now();
    whenIdle(() => emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at }));
    this.undo.push({ label: "stroke", undo: () => setDeleted([id], true), redo: () => setDeleted([id], false) });
    const n = g.data.pts.length / STROKE_STRIDE;
    const box = dataBox(g.data);
    whenIdle(() => void logEvent(this.notebookId, g.sec.id, "stroke", { id, tool: g.data.tool, points: n, durationMs: g.data.pts[g.data.pts.length - 1], box }));
  }

  private eraseAlong(g: Extract<Gesture, { type: "erase" }>, x: number, y: number) {
    const candidates = g.sec.strokes().filter((s) => !g.erased.has(s.id));
    const hits = hitStrokes(candidates, g.last[0], g.last[1], x, y, this.tool.eraserSize / 2);
    g.last = [x, y];
    g.at = [x, y];
    if (!hits.length) return;
    const ids = hits.map((h) => h.id);
    ids.forEach((id) => g.erased.add(id));
    if (this.persist) void setDeleted(ids, true);
  }

  private commitErase(g: Extract<Gesture, { type: "erase" }>) {
    if (!g.erased.size || !this.persist) return;
    const ids = [...g.erased];
    const at = Date.now();
    whenIdle(() => emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at }));
    this.undo.push({ label: "erase", undo: () => setDeleted(ids, false), redo: () => setDeleted(ids, true) });
    whenIdle(() => void logEvent(this.notebookId, g.sec.id, "erase", { ids }));
  }

  private commitLasso(g: Extract<Gesture, { type: "lasso" }>) {
    const rect = this.lassoShape === "rect";
    const poly = rect ? rectPoly(g.poly) : g.poly;
    // What was drawn, kept on the page: the area Copy image takes and Crop keeps.
    const drawn = clipBox(unionBox(poly.map(([x, y]) => ({ minX: x, maxX: x, minY: y, maxY: y })))!, g.rect.height / this.zoom);
    const picked = lassoStrokes(g.sec.strokes(), poly, this.lassoMode);
    const pictures = lassoImages(g.sec.images?.() ?? [], poly, this.lassoMode);
    const area = rect && drawn && drawn.maxX - drawn.minX >= 8 && drawn.maxY - drawn.minY >= 8 ? drawn : undefined;
    if (!picked.length && !pictures.length && !area) return;
    const box = unionBox([...picked.map(strokeBox), ...pictures.map((p) => imageBox(p.data)), ...(area ? [area] : [])])!;
    this.setSelection({ sectionId: g.sec.id, ids: new Set([...picked, ...pictures].map((s) => s.id)), box, area, bounds: drawn ?? undefined });
  }

  private async commitDrag(g: Extract<Gesture, { type: "drag" }>) {
    const { dx, dy, strokes, images } = g;
    const sel = this.selection;
    if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || !this.persist) {
      this.cb.onDragging(null);
      return;
    }
    await moveStrokes(strokes, dx, dy);
    if (images.length) await moveImages(images, dx, dy);
    this.cb.onDragging(null);
    if (sel) this.setSelection({ ...sel, box: shift(sel.box, dx, dy), area: sel.area && shift(sel.area, dx, dy), bounds: sel.bounds && shift(sel.bounds, dx, dy) });
    const ids = [...strokes, ...images].map((s) => s.id);
    // The selection box follows the ink back and forth, if those strokes are still selected.
    const current = async (ddx: number, ddy: number) => {
      const rows = (await db.entities.bulkGet(ids)).filter(Boolean) as (StrokeEntity | ImageEntity)[];
      await moveStrokes(rows.filter((r): r is StrokeEntity => r.kind === "stroke"), ddx, ddy);
      await moveImages(rows.filter((r): r is ImageEntity => r.kind === "image"), ddx, ddy);
      await this.refreshSelectionBox();
    };
    emitActivity({ notebookId: this.notebookId, source: "local", kinds: ["stroke"], at: Date.now() });
    this.undo.push({ label: "move", undo: () => current(-dx, -dy), redo: () => current(dx, dy) });
    whenIdle(() => void logEvent(this.notebookId, g.sec.id, "lasso_move", { ids, dx, dy }));
  }

  requestFrame() {
    // No overlay attached (headless replay, tests): draw() would have nothing to draw on.
    if (this.frame || !this.live) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const ctx = this.ctx;
    const canvas = this.live;
    if (!ctx || !canvas) return;
    if (this.gesture || this.pending.size || this.hover) this.wakeLive();
    else this.releaseLiveLater();
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
      // A section that unmounted (deleted, editor closing) has no element; its tile never acks.
      const el = p.sec.el as HTMLElement | null;
      if (!el) {
        this.pending.delete(id);
        continue;
      }
      toSection(el.getBoundingClientRect());
      paintStroke(ctx, p.data, p.path);
    }
    if (this.pending.size) this.requestFrame();

    const g = this.gesture;
    if (g?.type === "ink" && g.data.pts.length) {
      toSection(g.rect);
      const data = g.predicted.length ? { ...g.data, pts: g.data.pts.concat(g.predicted) } : g.data;
      // Drawn exactly as it will be committed (last: true puts the end on the tip rather than
      // trailing behind it), so lifting the Pencil doesn't visibly change the stroke.
      paintStroke(ctx, data, strokePath(data));
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
      const poly = this.lassoShape === "rect" ? rectPoly(g.poly) : g.poly;
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (this.lassoShape === "rect") ctx.closePath();
      ctx.setLineDash([6 / this.zoom, 5 / this.zoom]);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5 / this.zoom;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g?.type === "drag") {
      toSection(g.rect);
      ctx.translate(g.dx, g.dy);
      for (const p of g.images) {
        const img = imageElement(p.data.src);
        if (img.complete) ctx.drawImage(img, p.data.x, p.data.y, p.data.w, p.data.h);
      }
      for (const s of g.strokes) paintStroke(ctx, s.data, cachedPath(s));
    }

    const hoverEl = this.hover?.sec.el as HTMLElement | null | undefined;
    if (!g && this.hover && !hoverEl) this.hover = null;
    if (!g && this.hover && hoverEl) {
      const h = this.hover;
      toSection(hoverEl.getBoundingClientRect());
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

/**
 * A selection move limited to the page: the box stays within the page width and the section's
 * height. A box already past an edge may stay there but not go further out.
 */
export function clampMove(b: Box, dx: number, dy: number, height: number): [number, number] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, Math.min(0, lo)), Math.max(0, hi));
  return [clamp(dx, -b.minX, PAGE_WIDTH - b.maxX), clamp(dy, -b.minY, height - b.maxY)];
}

function inBox(b: Box, x: number, y: number, pad: number) {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}

/** How far a duplicate lands from its original, down and to the right (page units). */
const DUPLICATE_OFFSET = 24;

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

/** Whether `d` still has every field as in `fields`. */
function holds(d: Record<string, unknown>, fields: Record<string, unknown>) {
  return Object.keys(fields).every((k) => JSON.stringify(d[k]) === JSON.stringify(fields[k]));
}

async function moveImages(images: ImageEntity[], dx: number, dy: number) {
  if (images.length) await putEntities(images.map((p) => ({ ...p, data: { ...p.data, x: p.data.x + dx, y: p.data.y + dy } })));
}

/** The rectangle from a loop's first point to its last, as a loop. */
function rectPoly(poly: number[][]): number[][] {
  if (!poly.length) return poly;
  const [[x0, y0], [x1, y1]] = [poly[0], poly[poly.length - 1]];
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** A box kept on a page `height` tall; null when nothing of it is. */
function clipBox(b: Box, height: number): Box | null {
  const c = { minX: Math.max(0, b.minX), minY: Math.max(0, b.minY), maxX: Math.min(PAGE_WIDTH, b.maxX), maxY: Math.min(height, b.maxY) };
  return c.maxX > c.minX && c.maxY > c.minY ? c : null;
}

function shiftPts(src: number[], dx: number, dy: number) {
  const pts = src.slice();
  for (let i = 0; i < pts.length; i += STROKE_STRIDE) {
    pts[i] += dx;
    pts[i + 1] += dy;
  }
  return pts;
}

function shift(b: Box, dx: number, dy: number): Box {
  return { minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy };
}
