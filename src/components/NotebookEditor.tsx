"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { InkController, type Selection, type ToolState } from "@/ink/controller";
import { DEFAULT_SENSITIVITY, DEFAULT_SMOOTHING } from "@/ink/pen-feel";
import { emitActivity } from "@/lib/activity";
import { db, deviceId, deviceKind } from "@/lib/db";
import { useLayoutMode, useStoredState } from "@/lib/hooks";
import { addTextBox, insertSectionAfter, liveSections, logEvent, putEntities } from "@/lib/store";
import { PAGE_WIDTH, type NotebookEntity, type PresenceData, type PresenceEntity, type SectionEntity } from "@/lib/types";
import { SectionView } from "./SectionView";
import { SidePanel } from "./SidePanel";
import { Toolbar } from "./Toolbar";
import { Icon } from "./Icons";

const emitLocalText = (notebookId: string) => emitActivity({ notebookId, source: "local", kinds: ["text"], at: Date.now() });

const TOOLBAR_H = 56;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

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
  penSmoothing: DEFAULT_SMOOTHING,
  penSensitivity: DEFAULT_SENSITIVITY,
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
  // Tool state saved by an older version lacks newer fields such as the pen feel.
  const tool = useMemo(() => ({ ...DEFAULT_TOOL, ...storedTool }), [storedTool]);
  const [panelOpen, setPanelOpen] = useStoredState("padsync.panel", !isIpad);
  const [follow, setFollow] = useStoredState("padsync.follow", !isIpad);
  const [zoom, setZoom] = useState(() => (isIpad ? 1 : fitZoom(panelOpen, 360)));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<Set<string> | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null); // the page, scaled by transform; logical coords
  const pinchRef = useRef<HTMLDivElement>(null); // sizer around it, transformed during a pinch
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
  const layout = useLayoutMode(notebookId, controller);
  const panelWidth = isIpad ? 360 : layout.width;
  useLayoutEffect(() => {
    controller.configure(tool, zoom);
  }, [controller, tool, zoom]);

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
    const z = isIpad ? 1 : fitZoom(panelOpen, panelWidth);
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
        if (target.closest(".ink-surface")) e.preventDefault();
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
        // Scale the page's existing raster on the GPU while the fingers move; without this
        // Safari re-rasterizes the whole page every frame and shows the background meanwhile.
        pinchRef.current.style.willChange = "transform";
      }
    };

    const onMove = (e: TouchEvent) => {
      if ([...e.touches].some((t) => t.touchType === "stylus")) {
        if ((e.target as HTMLElement).closest(".ink-surface")) e.preventDefault();
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
        if (wrap) {
          wrap.style.transform = "";
          wrap.style.willChange = "";
        }
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
  }, [controller, undo, redo, setTool, tool]);

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

  useEffect(() => {
    if (!follow || !ipad || ipad.notebookId !== notebookId || !ipad.data.sectionId || controller.isDrawing()) return;
    const el = els.current.get(ipad.data.sectionId);
    if (!el) return;
    const delta = el.getBoundingClientRect().top + ipad.data.offsetY * controller.zoom - TOOLBAR_H;
    if (Math.abs(delta) < 4) return;
    followingScroll.current = performance.now();
    window.scrollBy({ top: delta, behavior: "smooth" });
  }, [follow, ipad, notebookId, controller]);

  useLayoutEffect(() => {
    if (isIpad) return;
    const entry = [...els.current].find(([, el]) => el.getBoundingClientRect().bottom > TOOLBAR_H);
    const offset = entry ? (TOOLBAR_H - entry[1].getBoundingClientRect().top) / controller.zoom : 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const next = fitZoom(panelOpen, panelWidth);
      setZoom(next);
      requestAnimationFrame(() => {
        if (entry) window.scrollBy(0, entry[1].getBoundingClientRect().top + offset * next - TOOLBAR_H);
      });
    };
    const end = (event: TransitionEvent) => { if (event.propertyName === "padding-right") finish(); };
    window.addEventListener("transitionend", end);
    const timer = setTimeout(finish, 400);
    return () => { clearTimeout(timer); window.removeEventListener("transitionend", end); };
  }, [panelWidth, panelOpen, isIpad, controller]);

  const loaded = sections !== undefined && notebook !== undefined;
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPageH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

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
    <div className="editor min-h-screen bg-canvas" style={{ paddingTop: TOOLBAR_H + 16, paddingRight: showPanel ? panelWidth : 0 }}>
      <style>{` .editor { transition: padding-right 250ms; } .editor > aside { transition: width 250ms; } @media (prefers-reduced-motion: reduce) { .editor, .editor > aside { transition: none; } } `}</style>
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
      />

      <div ref={pinchRef} className="mx-auto mb-[50vh]" style={{ width: PAGE_WIDTH * zoom, height: pageH * zoom }}>
      <div ref={wrapRef} className="page-wrap flex flex-col gap-6" style={{ width: PAGE_WIDTH, transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
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

function fitZoom(withPanel: boolean, width: number) {
  if (typeof window === "undefined") return 1;
  const avail = window.innerWidth - (withPanel ? width : 0) - 32;
  return clampZoom(Math.min(1, avail / PAGE_WIDTH));
}
