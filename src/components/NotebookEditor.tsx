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
import { RAIL_INSET, SIDEBAR_W, TOOLBAR_H, columnLayout, fitZoom, gutterFor, overlayInsets, pinchPlacement, toolbarVariant, verticalPadding, type PinchPlacement, type PinchStart } from "@/lib/notebook-viewport";
import { PAGE_WIDTH, type NotebookEntity, type PresenceData, type PresenceEntity, type SectionEntity } from "@/lib/types";
import { SectionView } from "./SectionView";
import { SidePanel } from "./SidePanel";
import { Toolbar } from "./Toolbar";
import { GestureRecognizer, actionLabel, type GestureAction, type GestureAt, type GestureKind, type TouchPoint } from "@/lib/touch-gestures";
import { useGestureBindings, useGestureTuning, useLassoSettings, usePrompts } from "@/lib/settings";
import { queuePrompt, type ChatPrompt } from "@/lib/prompts";
import { RadialFan, fanAt, pointAt, promptItems, type FanState } from "./RadialFan";
import { PromptRecorder } from "./PromptRecorder";
import { LassoCircle } from "./LassoCircle";
import { DEFAULT_RAIL, normalizeRail, railFloats, railThickness, type RailLayout } from "@/lib/rail-layout";
import { Icon } from "./Icons";

const emitLocalText = (notebookId: string) => emitActivity({ notebookId, source: "local", kinds: ["text"], at: Date.now() });

// How far two fingers must spread or close (as a share of their distance) before they zoom.
const PINCH_DEAD_ZONE = 0.03;

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
  const [storedRail, setRail] = useStoredState<RailLayout>("padsync.rail", DEFAULT_RAIL);
  const [lasso] = useLassoSettings(isIpad);
  const rail = useMemo(() => normalizeRail(storedRail), [storedRail]);
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
  const floating = railFloats(rail);
  const railInset = railThickness(rail, RAIL_INSET);
  const insets = useMemo(
    () => overlayInsets({ kind, sidebarOpen, panelWidth: panelOpen ? panelWidth : 0, railDock: rail.dock, railFloating: floating, railInset }),
    [kind, sidebarOpen, panelOpen, panelWidth, rail.dock, floating, railInset],
  );
  const column = columnLayout(viewport.w, PAGE_WIDTH * zoom, insets, gutter);
  const vpad = verticalPadding(insets, gutter);
  // What a pinch needs to work out the scroll limits at its new zoom.
  const geometry = useRef({ viewportW: viewport.w, insets, gutter });
  useLayoutEffect(() => {
    geometry.current = { viewportW: viewport.w, insets, gutter };
  }, [viewport.w, insets, gutter]);
  useLayoutEffect(() => {
    controller.configure(tool, zoom);
    controller.setLassoMode(lasso.mode);
  }, [controller, tool, zoom, lasso.mode]);
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

  // The tool before the current one, for the "previous tool" gesture.
  const previousKind = useRef<ToolState["kind"]>("pen");
  const setTool = useCallback(
    (t: ToolState) => {
      if (t.kind !== tool.kind) {
        controller.setSelection(null);
        previousKind.current = tool.kind;
      }
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

  // --- zoom: pinch, ctrl+wheel and reset all go through pinchPlacement, so the point under the
  //     fingers/cursor stays put as far as the pan limits at the new zoom allow ------------------
  /** The column and window now, for a zoom about the client point `anchor`. */
  const measureZoom = useCallback(
    (anchor: [number, number]): PinchStart | null => {
      const outer = pinchRef.current;
      const wrap = wrapRef.current;
      if (!outer || !wrap) return null;
      const rect = outer.getBoundingClientRect();
      // With sections scaled one by one, the "Blank page" button at the end keeps its size.
      const fixed = perSection ? ((wrap.lastElementChild as HTMLElement | null)?.offsetHeight ?? 0) : 0;
      const below = parseFloat(getComputedStyle(outer).marginBottom) || 0;
      return {
        zoom: controller.zoom,
        left: rect.left,
        top: rect.top,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        contentHeight: rect.bottom + window.scrollY + below,
        viewportH: window.innerHeight,
        scaledHeight: rect.height - fixed,
        anchor,
        ...geometry.current,
      };
    },
    [controller, perSection],
  );

  // The new zoom and scroll land in one frame, so the page never paints at the old zoom first.
  const commitZoom = useCallback(
    (placed: PinchPlacement, from: number) => {
      flushSync(() => setZoom(placed.zoom));
      window.scrollTo(placed.scrollX, placed.scrollY);
      if (placed.zoom !== from) void logEvent(notebookId, null, "zoom", { zoom: placed.zoom });
    },
    [notebookId],
  );

  const resetZoom = () => {
    const z = isIpad ? 1 : fitZoom(viewport.w, insets, gutter, PAGE_WIDTH);
    const start = measureZoom([0, 0]);
    if (!start) return;
    // Keeps the page's left edge and the line just under the header where they are.
    const at: [number, number] = [start.left, TOOLBAR_H + 10];
    commitZoom(pinchPlacement({ ...start, anchor: at }, z / start.zoom, at), start.zoom);
  };

  // Trackpad pinch on the Mac arrives as ctrl+wheel.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const at: [number, number] = [e.clientX, e.clientY];
      const start = measureZoom(at);
      if (!start) return;
      const placed = pinchPlacement(start, Math.exp(-e.deltaY * 0.01), at);
      if (placed.zoom !== start.zoom) commitZoom(placed, start.zoom);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [measureZoom, commitZoom]);

  // --- finger gestures (taps, double taps, press and hold), each doing what Settings says ----
  const [gestures] = useGestureBindings();
  const [tuning] = useGestureTuning();
  const [gestureNote, setGestureNote] = useState<{ text: string; n: number } | null>(null);
  // The ring that fills under a finger while a press and hold counts down. Its own component and
  // store, so a finger starting to scroll doesn't re-render the editor.
  const holdRing = useMemo(() => new HoldRingStore(), []);
  const runGesture = useRef<(g: GestureKind, at: GestureAt) => void>(() => {});
  const gestureBound = useRef<(g: GestureKind) => boolean>(() => false);
  const gestureAction = useRef<(g: GestureKind) => GestureAction>(() => "none");
  const gestureTuning = useRef(tuning);
  const note = useCallback((text: string) => setGestureNote((prev) => (gestureTuning.current.showNote ? { text, n: (prev?.n ?? 0) + 1 } : null)), []);

  // --- the prompt menu: ready-made chat prompts in a circle, from the toolbar or a gesture ----
  const [prompts] = usePrompts();
  const [promptFan, setPromptFanState] = useState<FanState | null>(null);
  // Touch handlers read the fan before React has re-rendered it.
  const promptFanRef = useRef<FanState | null>(null);
  const setPromptFan = useCallback((f: FanState | null) => {
    promptFanRef.current = f;
    setPromptFanState(f);
  }, []);
  const closePromptFan = useCallback(() => setPromptFan(null), [setPromptFan]);
  /** Opens the side panel if it is closed and hands the prompt to the chat (see prompts.ts). */
  // A prompt that records a voice message first: the recorder bar is up while it is set.
  const [recording, setRecording] = useState<ChatPrompt | null>(null);
  const closeRecorder = useCallback(() => setRecording(null), []);
  const sendPrompt = (pr: ChatPrompt, audio?: Blob) => {
    if (pr.voice && !audio) return setRecording(pr);
    if (!panelOpen) setPanelOpen(true);
    queuePrompt(pr, audio);
    note(audio ? `Sent: ${pr.label}` : pr.send ? `Asked: ${pr.label}` : `${pr.label}: finish it in the chat`);
  };
  // Set each render below, for the touch handlers.
  const promptMenu = useRef<{ open: (at: [number, number], sticky: boolean) => FanState | null; pick: (key: string) => void }>({ open: () => null, pick: () => {} });
  useLayoutEffect(() => {
    gestureBound.current = (g) => gestures[g] !== "none";
    gestureAction.current = (g) => gestures[g];
    gestureTuning.current = tuning;
    promptMenu.current = {
      open: (at, sticky) => {
        if (!prompts.length) {
          note("No prompts: add some in toolbar settings → Prompts");
          return null;
        }
        const f = fanAt(promptItems(prompts), at, sticky);
        setPromptFan(f);
        return f;
      },
      pick: (key) => {
        const pr = prompts.find((x) => x.id === key);
        if (pr) sendPrompt(pr);
      },
    };
    runGesture.current = (g, at) => {
      const action = gestures[g];
      if (action === "none" || action === "lassoHold") return;
      // Around the tap, open to be tapped.
      if (action === "promptMenu") return void promptMenu.current.open([at.x, at.y], true);
      if (action === "undo") void undo();
      else if (action === "redo") void redo();
      else if (action === "previousTool") setTool({ ...tool, kind: previousKind.current === tool.kind ? "pen" : previousKind.current });
      else if (action === "togglePanel") setPanelOpen(!panelOpen);
      else if (action === "resetZoom") resetZoom();
      else setTool({ ...tool, kind: action.slice(5) as ToolState["kind"] });
      // A short note of what the gesture did, so a stray tap is noticed.
      const text = action === "previousTool" ? actionLabel(`tool:${previousKind.current === tool.kind ? "pen" : previousKind.current}`) : actionLabel(action);
      note(text);
    };
  });
  useEffect(() => {
    if (!gestureNote) return;
    const t = setTimeout(() => setGestureNote(null), 900);
    return () => clearTimeout(t);
  }, [gestureNote]);

  // --- touch: Pencil never scrolls; one finger scrolls natively; two fingers pinch/pan; finger
  //     taps and holds go to the gesture recognizer -----------------------------------------
  useEffect(() => {
    // Until the fingers spread or close by PINCH_DEAD_ZONE a two-finger drag only pans, so a pan
    // keeps the zoom exact; past it the scale carries on smoothly from 1.
    // `moved`: how far the point between the fingers has travelled, to tell a pan from a tap.
    let pinch: { d0: number; zooming: boolean; start: PinchStart; placed: PinchPlacement | null; moved: number } | null = null;
    // Two or more fingers are or were down in this touch: its lifts are ours, not Safari's.
    let multi = false;
    // The finger drawing a lasso after a press and hold, by touch identifier.
    let lassoFinger: number | null = null;
    // The finger pointing into the prompt menu after a press and hold, where it pressed, and how
    // far it has gone.
    let promptFinger: { id: number; x: number; y: number; far: number } | null = null;
    const endPromptFinger = (lifted: boolean) => {
      if (!promptFinger) return;
      const { far } = promptFinger;
      promptFinger = null;
      const f = promptFanRef.current;
      if (!f) return;
      // Lifted pointing at a prompt: send it. Lifted without moving: leave it open to be tapped.
      if (lifted && f.hot >= 0) {
        setPromptFan(null);
        promptMenu.current.pick(f.items[f.hot].key);
      } else if (lifted && far <= gestureTuning.current.slop) setPromptFan({ ...f, sticky: true });
      else setPromptFan(null);
    };
    const gesture = new GestureRecognizer({
      emit: (g, at) => {
        if (g === "fingerHold") holdRing.set(null);
        if (g === "fingerHold" && gestureAction.current(g) === "lassoHold") {
          if (controller.beginFingerLasso(at.x, at.y)) {
            lassoFinger = at.id;
            note("Lasso");
          }
          return;
        }
        if (g === "fingerHold" && gestureAction.current(g) === "promptMenu") {
          if (promptMenu.current.open([at.x, at.y], false)) promptFinger = { id: at.id, x: at.x, y: at.y, far: 0 };
          return;
        }
        runGesture.current(g, at);
      },
      isBound: (g) => gestureBound.current(g),
      tuning: () => gestureTuning.current,
      onHold: (state, at) => holdRing.set(state === "start" ? { x: at.x, y: at.y, n: performance.now() } : null),
    });
    const endLasso = (cancel: boolean) => {
      if (lassoFinger === null) return;
      lassoFinger = null;
      controller.endFingerLasso(cancel);
    };
    const points = (list: Touch[]): TouchPoint[] => list.map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));

    const direct = (list: TouchList) => [...list].filter((t) => t.touchType !== "stylus");
    const mid = (a: Touch, b: Touch): [number, number] => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if ([...e.touches].some((t) => t.touchType === "stylus")) {
        gesture.pencil(performance.now());
        if (target.closest(".ink-surface, .ink-grab")) e.preventDefault();
        return;
      }
      const fingers = direct(e.touches);
      // A second finger while lassoing means a pinch or pan, not a selection: drop the lasso.
      if (lassoFinger !== null && fingers.length > 1) endLasso(true);
      if (promptFinger && fingers.length > 1) endPromptFinger(false);
      // One-finger gestures count on the page, not on its controls, a selection (a finger drags
      // that) or a text box being typed in.
      const onPage = !!target.closest(".ink-surface") && !target.closest("textarea, input, [contenteditable]");
      gesture.start(points(fingers), performance.now(), onPage);
      if (fingers.length > 1) multi = true;
      const start = fingers.length === 2 && !controller.isDrawing() ? measureZoom(mid(fingers[0], fingers[1])) : null;
      if (start) {
        const [a, b] = fingers;
        pinch = { d0: dist(a, b), zooming: false, start, placed: null, moved: 0 };
      }
    };

    const onMove = (e: TouchEvent) => {
      if ([...e.touches].some((t) => t.touchType === "stylus")) {
        if ((e.target as HTMLElement).closest(".ink-surface, .ink-grab")) e.preventDefault();
        return;
      }
      const fingers = direct(e.touches);
      if (promptFinger) {
        const pf = promptFinger;
        const f = fingers.find((t) => t.identifier === pf.id);
        const fan = promptFanRef.current;
        if (f && fan) {
          e.preventDefault();
          const dx = f.clientX - pf.x;
          const dy = f.clientY - pf.y;
          pf.far = Math.max(pf.far, Math.hypot(dx, dy));
          const next = pointAt(fan, dx, dy);
          if (next !== fan) setPromptFan(next);
          return;
        }
      }
      if (lassoFinger !== null) {
        const f = fingers.find((t) => t.identifier === lassoFinger);
        if (f) {
          // The held finger draws the lasso; the page must not scroll under it.
          e.preventDefault();
          controller.extendFingerLasso(f.clientX, f.clientY);
          return;
        }
      }
      gesture.move(points(fingers));
      if (!pinch || fingers.length !== 2) return;
      e.preventDefault();
      const [a, b] = fingers;
      const d = dist(a, b);
      if (!pinch.zooming && Math.abs(d / pinch.d0 - 1) > PINCH_DEAD_ZONE) {
        pinch.zooming = true;
        pinch.d0 = d;
      }
      const { start } = pinch;
      const m = mid(a, b);
      pinch.moved = Math.max(pinch.moved, Math.hypot(m[0] - start.anchor[0], m[1] - start.anchor[1]));
      const placed = (pinch.placed = pinchPlacement(start, pinch.zooming ? d / pinch.d0 : 1, m));
      // Drawn exactly where the commit will put the page, scroll limits included. Measured from
      // where the column sits now, in case Safari scrolled the window before the pinch took over.
      const x = placed.left - (start.left + start.scrollX - window.scrollX);
      const y = placed.top - (start.top + start.scrollY - window.scrollY);
      const wrap = pinchRef.current!;
      wrap.style.transformOrigin = "0 0";
      wrap.style.transform = `translate(${x}px, ${y}px) scale(${placed.zoom / start.zoom})`;
    };

    const onEnd = (e: TouchEvent) => {
      const fingers = direct(e.touches);
      if (pinch && fingers.length < 2) {
        const { placed, start, zooming, moved } = pinch;
        pinch = null;
        const wrap = pinchRef.current;
        if (wrap) wrap.style.transform = "";
        // In the same frame the transform comes off, so the page never paints back at the old zoom.
        // Fingers that only wobbled (a two-finger tap) leave the page where it was.
        if (placed && (zooming || moved > gestureTuning.current.slop)) commitZoom(placed, start.zoom);
      }
      // Two quick two-finger taps look to Safari like a double tap, which it answers by scrolling
      // the tapped section to the top of the screen. Taking the lifts of a multi-finger touch for
      // ourselves stops that; there is no click to lose, as more than one finger never makes one.
      if (multi && e.cancelable) e.preventDefault();
      if (!fingers.length) multi = false;
      // Lifting the lasso finger selects what it circled.
      if (lassoFinger !== null && !fingers.some((t) => t.identifier === lassoFinger)) endLasso(false);
      if (promptFinger && !fingers.some((t) => t.identifier === promptFinger!.id)) endPromptFinger(e.type !== "touchcancel");
      if (e.type === "touchcancel") gesture.cancel();
      else gesture.end(points(fingers), performance.now());
    };

    const opts = { passive: false } as const;
    window.addEventListener("touchstart", onStart, opts);
    window.addEventListener("touchmove", onMove, opts);
    window.addEventListener("touchend", onEnd, opts);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
      gesture.dispose();
      endLasso(true);
      endPromptFinger(false);
    };
  }, [controller, measureZoom, commitZoom, note, holdRing, setPromptFan]);

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
    // Once the panel or sidebar has slid into place (or straight away if nothing animates). The
    // zoom and the scroll that keeps the top line in place land in one frame, as in commitZoom.
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("transitionend", end);
      flushSync(() => setZoom(fit));
      if (entry) window.scrollBy(0, entry[1].getBoundingClientRect().top + offset * fit - TOOLBAR_H);
    };
    const end = (event: TransitionEvent) => { if (event.propertyName === "width") finish(); };
    window.addEventListener("transitionend", end);
    const timer = setTimeout(finish, controller.zoom === fit ? 0 : 300);
    return () => { clearTimeout(timer); window.removeEventListener("transitionend", end); };
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

  const sectionEl = useCallback((sid: string) => els.current.get(sid), []);
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
        rail={rail}
        setRail={setRail}
        rightInset={showPanel ? panelWidth : 0}
        prompts={prompts}
        onPrompt={sendPrompt}
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
            selectionBar={!lasso.circle}
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
      <HoldRing store={holdRing} holdMs={tuning.holdMs} label={gestures.fingerHold === "lassoHold" ? "Hold to lasso" : `Hold: ${actionLabel(gestures.fingerHold)}`} />
      {lasso.circle && selection && !dragging && (
        <LassoCircle
          selection={selection}
          sectionEl={sectionEl}
          zoom={zoom}
          settings={lasso}
          prompts={prompts}
          onAction={(a) => {
            const k = 1 + lasso.step / 100;
            if (a === "delete") void controller.deleteSelection();
            else if (a === "duplicate") {
              const sec = controller.sectionById(selection.sectionId);
              if (sec) void controller.duplicateSelection(sec);
            } else if (a === "bigger") void controller.scaleSelection(k);
            else if (a === "smaller") void controller.scaleSelection(1 / k);
            else if (a === "done") controller.setSelection(null);
          }}
          onRecolor={(color) => void controller.recolorSelection(color)}
          // The chat's own context choice becomes the selection: that is what was asked about.
          onPrompt={(pr) => sendPrompt({ ...pr, context: pr.context === "chat" ? "selection" : pr.context })}
          onNote={note}
        />
      )}
      {recording && <PromptRecorder key={recording.id} prompt={recording} onAudio={(audio) => sendPrompt(recording, audio)} onClose={closeRecorder} />}
      {promptFan && (
        <RadialFan
          fan={promptFan}
          label="Chat prompts"
          onPick={(item) => {
            setPromptFan(null);
            promptMenu.current.pick(item.key);
          }}
          onClose={closePromptFan}
        />
      )}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[4.25rem] z-50 flex justify-center">
        {gestureNote && <span key={gestureNote.n} className="rounded-full bg-slate-900/80 px-3 py-1 text-sm font-medium text-white shadow-lift">{gestureNote.text}</span>}
      </div>

      {showPanel && (
        <SidePanel
          notebookId={notebookId}
          mode={isIpad ? "drawing" : layout.effective}
          width={panelWidth}
          notebookTitle={notebook.data.title}
          selection={selection}
          sections={sections}
          current={current}
          sectionEl={sectionEl}
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

type Ring = { x: number; y: number; n: number } | null;

class HoldRingStore {
  private ring: Ring = null;
  private listeners = new Set<() => void>();
  get = () => this.ring;
  set(r: Ring) {
    if (r === this.ring) return;
    this.ring = r;
    this.listeners.forEach((fn) => fn());
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}

/**
 * Fills over the hold time around the finger (see .hold-ring); press and hold fires as it closes.
 * Wide enough to show around a fingertip, with what the hold will do written above it.
 */
function HoldRing({ store, holdMs, label }: { store: HoldRingStore; holdMs: number; label: string }) {
  const ring = useSyncExternalStore(store.subscribe, store.get, () => null);
  if (!ring) return null;
  return (
    <div
      key={ring.n}
      aria-hidden="true"
      className="hold-ring pointer-events-none fixed z-50 flex flex-col items-center"
      style={{ left: ring.x - HOLD_RING / 2, top: ring.y - HOLD_RING / 2 - 30, width: HOLD_RING, ["--hold-ms" as string]: `${holdMs}ms` }}
    >
      <span className="mb-1.5 whitespace-nowrap rounded-full bg-slate-900/80 px-2.5 py-0.5 text-xs font-medium text-white">{label}</span>
      <svg width={HOLD_RING} height={HOLD_RING} viewBox="0 0 144 144">
        <circle cx="72" cy="72" r="60" fill="rgb(37 99 235 / 0.06)" stroke="rgb(37 99 235 / 0.22)" strokeWidth="8" />
        <circle cx="72" cy="72" r="60" fill="none" stroke="#2563eb" strokeWidth="8" strokeLinecap="round" strokeDasharray="377" transform="rotate(-90 72 72)" />
      </svg>
    </div>
  );
}
/** The hold ring's size: twice a fingertip, so the part still to fill shows around it. */
const HOLD_RING = 144;
