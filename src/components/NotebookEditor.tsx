"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { InkController, type Selection, type ToolState } from "@/ink/controller";
import { legacyOverrides } from "@/ink/pen-feel";
import { emitActivity } from "@/lib/activity";
import { db, deviceId, deviceKind } from "@/lib/db";
import { useLayoutMode, useStoredState } from "@/lib/hooks";
import { addTextBox, insertSectionAfter, liveSections, logEvent, putEntities } from "@/lib/store";
import { registerDebugProbe } from "@/lib/sync-debug";
import { renderFlag } from "@/lib/render-flags";
import { SIDEBAR_W, TOOLBAR_H, clampZoom, columnLayout, fitZoom, gutterFor, overlayInsets, toolbarVariant, verticalPadding } from "@/lib/notebook-viewport";
import { PAGE_WIDTH, type NotebookEntity, type PresenceData, type PresenceEntity, type SectionEntity } from "@/lib/types";
import { SectionView } from "./SectionView";
import { SidePanel } from "./SidePanel";
import { Toolbar } from "./Toolbar";
import { Icon } from "./Icons";

const emitLocalText = (notebookId: string) => emitActivity({ notebookId, source: "local", kinds: ["text"], at: Date.now() });

// The Mac only follows the iPad after this long without input of its own.
const FOLLOW_IDLE_MS = 15000;

// Where this device last was in each notebook: a section and the logical offset into it.
type Position = { sectionId: string; offsetY: number };
const positionKey = (notebookId: string) => `padsync.position.${notebookId}`;
function readPosition(notebookId: string): Position | null {
  try {
    const p = JSON.parse(localStorage.getItem(positionKey(notebookId)) ?? "null");
    return p && typeof p.sectionId === "string" && typeof p.offsetY === "number" ? p : null;
  } catch {
    return null;
  }
}

const DEFAULT_TOOL: ToolState = {
  kind: "pen",
  penColor: "#111827",
  penSize: 3.4,
  hlColor: "#facc15",
  hlSize: 22,
  eraserSize: 24,
};

export default function NotebookEditor() {
  const id = useSearchParams().get("id") ?? "";
  if (!id) return <Missing />;
  return <Editor key={id} notebookId={id} />;
}

function Missing() {
  return (
    <div className="p-10 text-slate-600">
      Notebook not found. <Link href="/" className="text-blue-700 underline">Back to library</Link>
    </div>
  );
}

function Editor({ notebookId }: { notebookId: string }) {
  const kind = deviceKind();
  const isIpad = kind === "ipad";
  const notebook = useLiveQuery(() => db.entities.get(notebookId), [notebookId]) as NotebookEntity | undefined;
  // Any section write re-runs the query with fresh objects; keeping the old object for sections
  // whose hlc did not change lets every other SectionView skip re-rendering.
  const [sectionCache] = useState(() => new Map<string, SectionEntity>());
  const sections = useLiveQuery(
    () =>
      liveSections(notebookId).then((rows) =>
        rows.map((s) => {
          const prev = sectionCache.get(s.id);
          if (prev && prev.hlc === s.hlc) return prev;
          sectionCache.set(s.id, s);
          return s;
        }),
      ),
    [notebookId, sectionCache],
  );

  const [storedTool, setToolState] = useStoredState<ToolState>("padsync.tool", DEFAULT_TOOL);
  // Tool state saved by an older version lacks newer fields; its quick pen feel becomes pen overrides.
  const tool = useMemo(() => {
    const { penSmoothing, penSensitivity, ...rest } = storedTool;
    return { ...DEFAULT_TOOL, ...rest, pen: rest.pen ?? legacyOverrides(penSmoothing, penSensitivity) };
  }, [storedTool]);
  const [panelOpen, setPanelOpen] = useStoredState("padsync.panel", !isIpad);
  const [follow, setFollow] = useStoredState("padsync.follow", !isIpad);
  // The Mac's tool sidebar; the iPad keeps its floating rail.
  const variant = toolbarVariant(kind);
  const [sidebarOpen, setSidebarOpen] = useStoredState("padsync.toolSidebar", true);
  const gutter = gutterFor(kind);
  const viewport = useViewport();
  // A first guess until the layout mode knows the panel width; the refit below corrects it.
  const [zoom, setZoom] = useState(() => (isIpad ? 1 : fitZoom(viewport.w, overlayInsets({ kind, sidebarOpen, panelWidth: panelOpen ? viewport.w / 2 : 0 }), gutter, PAGE_WIDTH)));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<Set<string> | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  // The column of sections at screen size: each section scales itself (see SectionView), and the
  // gaps scale with them, so (client - column origin) / zoom is still a page coordinate.
  const wrapRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<HTMLDivElement>(null); // around it, transformed during a pinch
  // sectionScale off (render flags): the old way, one transform over the whole column.
  const perSection = renderFlag("sectionScale");
  const [pageH, setPageH] = useState(0);
  const els = useRef(new Map<string, HTMLElement>());
  const zoomAnchor = useRef<{ lx: number; ly: number; cx: number; cy: number } | null>(null);

  const controller = useMemo(
    () =>
      new InkController(notebookId, tool, {
        onSelection: setSelection,
        onDragging: setDragging,
        onTextCreate: async (sectionId, x, y) => {
          const tid = await addTextBox(notebookId, sectionId, x, y);
          emitLocalText(notebookId);
          setEditingText(tid);
          void logEvent(notebookId, sectionId, "text_create", { id: tid });
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notebookId],
  );
  const sidebarW = variant === "sidebar" ? (sidebarOpen ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed) : 0;
  const layout = useLayoutMode(notebookId, controller, sidebarW);
  const panelWidth = isIpad ? 360 : layout.width;
  // What covers the window around the page, and where the page sits so every part of it can be
  // panned clear of the header, the tools and the side panel (see notebook-viewport).
  const insets = useMemo(() => overlayInsets({ kind, sidebarOpen, panelWidth: panelOpen ? panelWidth : 0 }), [kind, sidebarOpen, panelOpen, panelWidth]);
  const column = columnLayout(viewport.w, PAGE_WIDTH * zoom, insets, gutter);
  const vpad = verticalPadding(insets, gutter);
  useLayoutEffect(() => {
    controller.configure(tool, zoom);
  }, [controller, tool, zoom]);
  useEffect(
    () =>
      registerDebugProbe("Editor", () => ({
        zoom: Math.round(controller.zoom * 100) / 100,
        tool: controller.tool.kind,
        drawing: controller.isDrawing(),
        selected: controller.selection?.ids.size ?? 0,
        sections: els.current.size,
        undo: controller.undo.canUndo,
        scrollY: Math.round(window.scrollY),
        scrollX: Math.round(window.scrollX),
        pageHeight: document.documentElement.scrollHeight,
        pageWidth: document.documentElement.scrollWidth,
        panelOpen,
        sidebarOpen: variant === "sidebar" ? sidebarOpen : null,
        insets: `${insets.top} ${insets.right} ${insets.bottom} ${insets.left}`,
      })),
    [controller, panelOpen, sidebarOpen, variant, insets],
  );

  const undoState = useSyncExternalStore(
    (fn) => controller.undo.subscribe(fn),
    () => `${controller.undo.canUndo}:${controller.undo.canRedo}`,
    () => "false:false",
  );
  const [canUndo, canRedo] = undoState.split(":").map((v) => v === "true");

  const setTool = useCallback(
    (t: ToolState) => {
      if (t.kind !== tool.kind) controller.setSelection(null);
      setToolState(t);
      // Log tool and colour picks, not every step of a pen-feel slider.
      const color = t.kind === "highlighter" ? t.hlColor : t.penColor;
      if (t.kind !== tool.kind || color !== (tool.kind === "highlighter" ? tool.hlColor : tool.penColor)) {
        void logEvent(notebookId, null, "tool", { kind: t.kind, color });
      }
    },
    [controller, notebookId, setToolState, tool],
  );

  const undo = useCallback(async () => {
    const label = await controller.undo.undo();
    if (label) void logEvent(notebookId, null, "undo", { label });
  }, [controller, notebookId]);
  const redo = useCallback(async () => {
    const label = await controller.undo.redo();
    if (label) void logEvent(notebookId, null, "redo", { label });
  }, [controller, notebookId]);

  // A callback ref: the overlay canvas only mounts once the notebook has loaded, after the
  // controller's mount effects have already run.
  const liveRef = useCallback((c: HTMLCanvasElement | null) => controller.attachLive(c), [controller]);
  useEffect(() => {
    const onResize = () => controller.resizeLive();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [controller]);

  // Switching apps, Slide Over or a system gesture can swallow the Pencil's pointerup.
  useEffect(() => {
    const end = () => controller.endGesture();
    const vis = () => document.visibilityState === "hidden" && end();
    window.addEventListener("blur", end);
    window.addEventListener("pagehide", end);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("blur", end);
      window.removeEventListener("pagehide", end);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [controller]);

  useEffect(() => {
    void logEvent(notebookId, null, "open", { device: kind });
    const vis = () => void logEvent(notebookId, null, "visibility", { state: document.visibilityState });
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [notebookId, kind]);

  // --- zoom, anchored so the point under the fingers/cursor stays put -------------------------
  const zoomAt = useCallback(
    (next: number, lx: number, ly: number, cx: number, cy: number) => {
      zoomAnchor.current = { lx, ly, cx, cy };
      setZoom(clampZoom(next));
    },
    [],
  );

  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const wrap = wrapRef.current;
    if (!a || !wrap) return;
    zoomAnchor.current = null;
    const r = wrap.getBoundingClientRect();
    window.scrollBy(r.left + a.lx * zoom - a.cx, r.top + a.ly * zoom - a.cy);
    void logEvent(notebookId, null, "zoom", { zoom });
  }, [zoom, notebookId]);

  const resetZoom = () => {
    const z = isIpad ? 1 : fitZoom(viewport.w, insets, gutter, PAGE_WIDTH);
    const wrap = wrapRef.current!;
    const r = wrap.getBoundingClientRect();
    const cy = TOOLBAR_H + 10;
    zoomAt(z, 0, (cy - r.top) / zoom, r.left, cy);
  };

  // Trackpad pinch on the Mac arrives as ctrl+wheel.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const z = controller.zoom;
      zoomAt(z * Math.exp(-e.deltaY * 0.01), (e.clientX - r.left) / z, (e.clientY - r.top) / z, e.clientX, e.clientY);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [controller, zoomAt]);

  // --- touch: Pencil never scrolls; one finger scrolls natively; two fingers pinch/pan;
  //     two-finger tap = undo, three-finger tap = redo ---------------------------------------
  useEffect(() => {
    let pinch: { d0: number; m0: [number, number]; m: [number, number]; s: number; rect: DOMRect; page: DOMRect; z: number } | null = null;
    let tap: { n: number; t: number; moved: boolean; start: [number, number][] } | null = null;

    const direct = (list: TouchList) => [...list].filter((t) => t.touchType !== "stylus");
    const mid = (a: Touch, b: Touch): [number, number] => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if ([...e.touches].some((t) => t.touchType === "stylus")) {
        if (target.closest(".ink-surface, .ink-grab")) e.preventDefault();
        return;
      }
      const fingers = direct(e.touches);
      if (fingers.length >= 2 && !tap) tap = { n: fingers.length, t: performance.now(), moved: false, start: fingers.map((f) => [f.clientX, f.clientY]) };
      else if (tap) tap.n = Math.max(tap.n, fingers.length);
      if (fingers.length === 1) tap = null;
      if (fingers.length === 2 && pinchRef.current && wrapRef.current && !controller.isDrawing()) {
        const [a, b] = fingers;
        const rect = pinchRef.current.getBoundingClientRect();
        const page = wrapRef.current.getBoundingClientRect();
        pinch = { d0: dist(a, b), m0: mid(a, b), m: mid(a, b), s: 1, rect, page, z: controller.zoom };
      }
    };

    const onMove = (e: TouchEvent) => {
      if ([...e.touches].some((t) => t.touchType === "stylus")) {
        if ((e.target as HTMLElement).closest(".ink-surface, .ink-grab")) e.preventDefault();
        return;
      }
      const fingers = direct(e.touches);
      if (tap) {
        tap.moved ||= fingers.some((f, i) => tap!.start[i] && Math.hypot(f.clientX - tap!.start[i][0], f.clientY - tap!.start[i][1]) > 12);
      }
      if (!pinch || fingers.length !== 2) return;
      e.preventDefault();
      const [a, b] = fingers;
      pinch.m = mid(a, b);
      pinch.s = clampZoom(pinch.z * (dist(a, b) / pinch.d0)) / pinch.z;
      const { rect, m0, m, s } = pinch;
      const px = m0[0] - rect.left, py = m0[1] - rect.top;
      const wrap = pinchRef.current!;
      wrap.style.transformOrigin = "0 0";
      wrap.style.transform = `translate(${m[0] - rect.left - px * s}px, ${m[1] - rect.top - py * s}px) scale(${s})`;
    };

    const onEnd = (e: TouchEvent) => {
      const fingers = direct(e.touches);
      if (pinch && fingers.length < 2) {
        const { page, m0, m, s, z } = pinch;
        pinch = null;
        const wrap = pinchRef.current;
        if (wrap) wrap.style.transform = "";
        // Commit the new zoom in the same frame the pinch transform comes off (the anchor scroll
        // measures the page untransformed), so the page never paints a frame back at the old zoom
        // and re-rasterizes twice.
        if (Math.abs(s - 1) > 0.01 || Math.hypot(m[0] - m0[0], m[1] - m0[1]) > 2) {
          flushSync(() => zoomAt(z * s, (m0[0] - page.left) / z, (m0[1] - page.top) / z, m[0], m[1]));
        }
      }
      if (tap && fingers.length === 0) {
        const quick = performance.now() - tap.t < 280 && !tap.moved;
        if (quick && tap.n === 2) void undo();
        if (quick && tap.n === 3) void redo();
        tap = null;
      }
    };

    const opts = { passive: false } as const;
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchmove", onMove, opts);
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [controller, zoomAt, undo, redo]);

  // --- keyboard (Mac) ---------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const map: Record<string, ToolState["kind"]> = { p: "pen", h: "highlighter", e: "eraser", l: "lasso", t: "text" };
      const k = map[e.key.toLowerCase()];
      if (k) setTool({ ...tool, kind: k });
      if (e.key === "\\" && variant === "sidebar") setSidebarOpen(!sidebarOpen);
      if ((e.key === "Backspace" || e.key === "Delete") && controller.selection) void controller.deleteSelection();
      if (e.key === "Escape") controller.setSelection(null);
    };
    // iPadOS system undo/redo (Pencil Pro squeeze scrubber, three-finger swipe, the shortcut
    // bar) arrives as beforeinput history events rather than keydown.
    const onBeforeInput = (e: InputEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      if (e.inputType === "historyUndo") {
        e.preventDefault();
        void undo();
      } else if (e.inputType === "historyRedo") {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [controller, undo, redo, setTool, tool, variant, sidebarOpen, setSidebarOpen]);

  // --- current section + presence ---------------------------------------------------------
  const lastPresence = useRef(0);
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRef = useRef<string | null>(null);
  const followingScroll = useRef(0);

  // Reopen where this device left the notebook. Saving waits until the restore is over, so the
  // scroll-to-top of a fresh mount never overwrites the saved place.
  const [savedPosition] = useState(() => readPosition(notebookId));
  const restored = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePosition = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const sid = currentRef.current;
    const el = sid ? els.current.get(sid) : undefined;
    if (!restored.current || !sid || !el) return;
    const offsetY = Math.round((TOOLBAR_H - el.getBoundingClientRect().top) / controller.zoom);
    try {
      localStorage.setItem(positionKey(notebookId), JSON.stringify({ sectionId: sid, offsetY } satisfies Position));
    } catch {}
  }, [controller, notebookId]);

  useEffect(() => {
    const flush = () => saveTimer.current && savePosition();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [savePosition]);

  const publishPresence = useCallback(() => {
    const sid = currentRef.current;
    const el = sid ? els.current.get(sid) : undefined;
    const offsetY = el ? (TOOLBAR_H - el.getBoundingClientRect().top) / controller.zoom : 0;
    const data: PresenceData = { device: deviceId(), deviceKind: kind, sectionId: sid, offsetY: Math.round(offsetY), at: Date.now() };
    lastPresence.current = Date.now();
    void putEntities([{ id: `presence-${deviceId()}`, kind: "presence", notebookId, parentId: "", data, hlc: "", deleted: 0, dirty: 1 }]);
  }, [controller, kind, notebookId]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const probe = TOOLBAR_H + (window.innerHeight - TOOLBAR_H) * 0.3;
        let found: string | null = null;
        for (const [sid, el] of els.current) {
          const r = el.getBoundingClientRect();
          if (r.top <= probe && r.bottom >= probe) found = sid;
        }
        if (found && found !== currentRef.current) {
          currentRef.current = found;
          setCurrentId(found);
          void logEvent(notebookId, found, "focus", {});
        }
        if (restored.current) {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(savePosition, 300);
        }
        // Only the device being written on reports where it is; a following Mac stays quiet.
        if (performance.now() - followingScroll.current < 1500) return;
        if (presenceTimer.current) clearTimeout(presenceTimer.current);
        const wait = Math.max(0, 800 - (Date.now() - lastPresence.current));
        presenceTimer.current = setTimeout(publishPresence, wait);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      if (presenceTimer.current) clearTimeout(presenceTimer.current);
    };
  }, [notebookId, publishPresence, savePosition, sections?.length]);

  const presences = useLiveQuery(() => db.entities.where("kind").equals("presence").toArray(), []) as PresenceEntity[] | undefined;
  const ipad = useMemo(() => {
    const others = (presences ?? []).filter((p) => p.data.deviceKind === "ipad" && p.data.device !== deviceId());
    return others.sort((a, b) => b.data.at - a.data.at)[0] ?? null;
  }, [presences]);

  // Clicking, scrolling, typing (chat included) or opening the notebook restarts the idle clock;
  // moving the pointer alone does not, so reading with the mouse resting on the page still follows.
  const lastInput = useRef(0);
  const [idleAt, setIdleAt] = useState(0);
  useEffect(() => {
    if (isIpad) return;
    let timer: ReturnType<typeof setTimeout>;
    const mark = () => {
      lastInput.current = performance.now();
      clearTimeout(timer);
      timer = setTimeout(() => setIdleAt(performance.now()), FOLLOW_IDLE_MS);
    };
    const inputs = ["pointerdown", "wheel", "keydown", "touchstart"] as const;
    inputs.forEach((t) => window.addEventListener(t, mark, { passive: true, capture: true }));
    mark();
    return () => {
      clearTimeout(timer);
      inputs.forEach((t) => window.removeEventListener(t, mark, { capture: true }));
    };
  }, [isIpad]);

  useEffect(() => {
    if (!follow || !ipad || ipad.notebookId !== notebookId || !ipad.data.sectionId || controller.isDrawing()) return;
    if (performance.now() - lastInput.current < FOLLOW_IDLE_MS) return;
    const el = els.current.get(ipad.data.sectionId);
    if (!el) return;
    const delta = el.getBoundingClientRect().top + ipad.data.offsetY * controller.zoom - TOOLBAR_H;
    if (Math.abs(delta) < 4) return;
    followingScroll.current = performance.now();
    window.scrollBy({ top: delta, behavior: "smooth" });
  }, [follow, ipad, notebookId, controller, idleAt]);

  // The Mac refits its zoom when the side panel or tool sidebar changes the visible strip, keeping
  // the line at the top of the screen in place.
  const fit = isIpad ? 1 : fitZoom(viewport.w, insets, gutter, PAGE_WIDTH);
  useLayoutEffect(() => {
    if (isIpad) return;
    const entry = [...els.current].find(([, el]) => el.getBoundingClientRect().bottom > TOOLBAR_H);
    const offset = entry ? (TOOLBAR_H - entry[1].getBoundingClientRect().top) / controller.zoom : 0;
    let frame = 0;
    // Once the panel or sidebar has slid into place (or straight away if nothing animates).
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("transitionend", end);
      setZoom(fit);
      frame = requestAnimationFrame(() => {
        if (entry) window.scrollBy(0, entry[1].getBoundingClientRect().top + offset * fit - TOOLBAR_H);
      });
    };
    const end = (event: TransitionEvent) => { if (event.propertyName === "width") finish(); };
    window.addEventListener("transitionend", end);
    const timer = setTimeout(finish, controller.zoom === fit ? 0 : 300);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener("transitionend", end); };
  }, [fit, isIpad, controller]);

  const loaded = sections !== undefined && notebook !== undefined;
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || perSection) return;
    const ro = new ResizeObserver(() => setPageH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded, perSection]);

  useLayoutEffect(() => {
    if (!loaded || restored.current) return;
    const target = savedPosition ? els.current.get(savedPosition.sectionId) : undefined;
    if (!savedPosition || !target || !pinchRef.current) {
      restored.current = true;
      return;
    }
    const align = () => window.scrollBy(0, target.getBoundingClientRect().top + savedPosition.offsetY * controller.zoom - TOOLBAR_H);
    // Sections above grow as their text and ink measure in, and the Mac refits its zoom; keep the
    // place pinned until the reader moves the page or things settle.
    const ro = new ResizeObserver(align);
    ro.observe(pinchRef.current);
    align();
    const stop = () => {
      restored.current = true;
      cleanup();
    };
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const timer = setTimeout(stop, 1500);
    inputs.forEach((t) => window.addEventListener(t, stop, { passive: true, capture: true }));
    function cleanup() {
      ro.disconnect();
      clearTimeout(timer);
      inputs.forEach((t) => window.removeEventListener(t, stop, { capture: true }));
    }
    return cleanup;
  }, [loaded, savedPosition, controller]);

  const registerEl = useCallback((sid: string, el: HTMLElement | null) => {
    if (el) els.current.set(sid, el);
    else els.current.delete(sid);
  }, []);

  const jump = (sid: string) => {
    const el = els.current.get(sid);
    if (el) window.scrollBy({ top: el.getBoundingClientRect().top - TOOLBAR_H - 12, behavior: "smooth" });
  };

  if (notebook === undefined || sections === undefined) return <div className="p-10 text-slate-400">Loading…</div>;
  if (!notebook || notebook.deleted) return <Missing />;

  const current = sections.find((s) => s.id === currentId) ?? sections[0] ?? null;
  const showPanel = panelOpen;

  return (
    <div className="editor min-h-screen bg-canvas" style={{ paddingTop: vpad.top, minWidth: column.contentWidth }} data-variant={variant}>
      <Toolbar
        notebookId={notebookId}
        layout={isIpad ? undefined : layout}
        title={notebook.data.title}
        tool={tool}
        setTool={setTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        zoom={zoom}
        onZoomReset={resetZoom}
        panelOpen={showPanel}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        variant={variant}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* Not one transform over the whole notebook: on the iPad a scaled layer that tall (300k px for
          150 sections) loses tiles, which show as black blocks, and runs Safari out of memory. */}
      <div ref={pinchRef} style={{ marginLeft: column.left, marginBottom: `max(${vpad.bottomShare * 100}vh, ${vpad.bottomMin}px)`, width: PAGE_WIDTH * zoom, ...(perSection ? {} : { height: pageH * zoom }) }}>
      <div ref={wrapRef} className="page-wrap flex flex-col" style={perSection ? { width: PAGE_WIDTH * zoom, gap: 24 * zoom } : { width: PAGE_WIDTH, gap: 24, transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
        {sections.map((s, i) => (
          <SectionView
            key={s.id}
            section={s}
            index={i}
            controller={controller}
            zoom={zoom}
            selection={selection?.sectionId === s.id ? selection : null}
            draggingIds={selection?.sectionId === s.id ? dragging : null}
            editingTextId={editingText}
            setEditingTextId={setEditingText}
            registerEl={registerEl}
            textMode={tool.kind === "text"}
          />
        ))}
        <button
          className="mx-auto flex items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 px-8 py-4 text-base font-medium text-slate-500 transition-colors hover:border-brand-300 hover:bg-white hover:text-brand-700"
          onClick={async () => { await insertSectionAfter(notebookId, sections[sections.length - 1] ?? null, sections); emitActivity({ notebookId, source: "local", kinds: ["section"], at: Date.now() }); }}
        >
          <Icon name="plus" /> Blank page
        </button>
      </div>
      </div>

      <canvas ref={liveRef} className="pointer-events-none fixed left-0 top-0 z-30" />

      {showPanel && (
        <SidePanel
          notebookId={notebookId}
          mode={isIpad ? "drawing" : layout.effective}
          width={panelWidth}
          notebookTitle={notebook.data.title}
          selection={selection}
          sections={sections}
          current={current}
          sectionEl={(sid) => els.current.get(sid)}
          follow={follow}
          setFollow={setFollow}
          ipad={ipad}
          onJump={jump}
        />
      )}
    </div>
  );
}

/** Window width in CSS px, without the vertical scrollbar where one takes up room. */
function useViewport() {
  const read = () => ({ w: typeof window === "undefined" ? 1024 : document.documentElement.clientWidth || window.innerWidth });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const update = () => setSize((prev) => {
      const next = read();
      return prev.w === next.w ? prev : next;
    });
    window.addEventListener("resize", update);
    update();
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}
