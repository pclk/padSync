import { deviceId, deviceKind } from "@/lib/db";
import type { PencilRecorder, TransformInput } from "./recorder";
import type { RecordingEnvironment, TargetKind } from "./schema";

// DOM wiring for the recorder: capture-phase listeners on window, so every pointer and touch event
// is seen in dispatch order before any app handler can filter, cancel or stop it. Passive: the
// recorder never changes what the page does with the input.

export interface CaptureSurface {
  /** The test page; targets inside it but outside the surface are its controls ("ui"). */
  root: () => HTMLElement | null;
  /** The element strokes are drawn on. */
  surface: () => HTMLElement | null;
  /** The surface's current client → surface-local mapping. */
  transform: () => TransformInput;
}

const POINTER_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerover", "pointerout", "gotpointercapture", "lostpointercapture"];
// These don't bubble and fire for every element entered; only the surface's own are kept.
const SURFACE_ONLY = ["pointerenter", "pointerleave"];
const TOUCH_TYPES = ["touchstart", "touchmove", "touchend", "touchcancel"];

export function attachInputCapture(rec: PencilRecorder, s: CaptureSurface): () => void {
  const targetKind = (t: EventTarget | null): TargetKind => {
    const el = t instanceof Node ? t : null;
    if (!el) return "other";
    if (s.surface()?.contains(el)) return "surface";
    return s.root()?.contains(el) ? "ui" : "other";
  };
  const onPointer = (e: Event) => {
    if (!rec.recording) return;
    rec.pointer(e as PointerEvent, targetKind(e.target), s.transform(), performance.now());
  };
  const onSurfacePointer = (e: Event) => {
    if (rec.recording && e.target === s.surface()) onPointer(e);
  };
  const onTouch = (e: Event) => {
    if (!rec.recording) return;
    rec.touch(e as TouchEvent, targetKind(e.target), s.transform(), performance.now());
  };
  const mark = (type: string, detail: Record<string, string | number | boolean | null> = {}, t = performance.now()) => {
    if (rec.recording) rec.marker(type, t, performance.now(), detail, s.transform());
  };
  const onVisibility = (e: Event) => mark("visibilitychange", { state: document.visibilityState }, e.timeStamp);
  const onPage = (e: Event) => mark(e.type, { persisted: (e as PageTransitionEvent).persisted ?? null }, e.timeStamp);
  // Window focus only; capture-phase focus events of elements would arrive here too.
  const onFocus = (e: Event) => {
    if (e.target === window) mark(e.type, {}, e.timeStamp);
  };
  const onResize = (e: Event) => mark(e.type, { innerWidth: window.innerWidth, innerHeight: window.innerHeight }, e.timeStamp);
  // Scrolling moves the surface under a still pen; markers at most every 100 ms (the transform on
  // each pointer event is exact either way).
  let lastScroll = 0;
  const onScroll = (e: Event) => {
    if (e.target !== document || e.timeStamp - lastScroll < 100) return;
    lastScroll = e.timeStamp;
    mark("scroll", { x: window.scrollX, y: window.scrollY }, e.timeStamp);
  };

  const opts = { capture: true, passive: true } as const;
  const pointerTypes = "onpointerrawupdate" in window ? [...POINTER_TYPES, "pointerrawupdate"] : POINTER_TYPES;
  const added: [EventTarget, string, EventListener][] = [
    ...pointerTypes.map((t) => [window, t, onPointer] as [EventTarget, string, EventListener]),
    ...SURFACE_ONLY.map((t) => [window, t, onSurfacePointer] as [EventTarget, string, EventListener]),
    ...TOUCH_TYPES.map((t) => [window, t, onTouch] as [EventTarget, string, EventListener]),
    [document, "visibilitychange", onVisibility],
    [window, "pagehide", onPage],
    [window, "pageshow", onPage],
    [window, "focus", onFocus],
    [window, "blur", onFocus],
    [window, "resize", onResize],
    [window, "orientationchange", onResize],
    [document, "scroll", onScroll],
  ];
  for (const [t, type, fn] of added) t.addEventListener(type, fn, opts);
  return () => {
    for (const [t, type, fn] of added) t.removeEventListener(type, fn, opts);
  };
}

const has = (proto: object | undefined, key: string) => !!proto && key in proto;

/** Which input APIs this browser exposes (feature detection: says nothing about the hardware). */
export function detectApis(): Record<string, boolean> {
  const pe = typeof PointerEvent === "undefined" ? undefined : PointerEvent.prototype;
  const touch = typeof Touch === "undefined" ? undefined : Touch.prototype;
  return {
    pointerEvents: !!pe,
    getCoalescedEvents: has(pe, "getCoalescedEvents"),
    getPredictedEvents: has(pe, "getPredictedEvents"),
    pointerRawUpdate: "onpointerrawupdate" in window,
    pointerAltitudeAngle: has(pe, "altitudeAngle"),
    pointerAzimuthAngle: has(pe, "azimuthAngle"),
    pointerTwist: has(pe, "twist"),
    pointerTangentialPressure: has(pe, "tangentialPressure"),
    pointerTilt: has(pe, "tiltX"),
    persistentDeviceId: has(pe, "persistentDeviceId"),
    touchEvents: typeof TouchEvent !== "undefined",
    touchType: has(touch, "touchType"),
    touchForce: has(touch, "force"),
    touchAltitudeAngle: has(touch, "altitudeAngle"),
    touchAzimuthAngle: has(touch, "azimuthAngle"),
    touchRadius: has(touch, "radiusX"),
  };
}

const media = (q: string) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);

export function captureEnvironment(): RecordingEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { platform: string; mobile: boolean; brands: { brand: string; version: string }[] } };
  const uad = nav.userAgentData;
  return {
    userAgent: nav.userAgent,
    platform: nav.platform ?? "",
    vendor: nav.vendor ?? "",
    language: nav.language ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    deviceKind: deviceKind(),
    deviceId: deviceId(),
    standalone: nav.standalone === true || media("(display-mode: standalone)"),
    secureContext: window.isSecureContext,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      orientation: screen.orientation?.type ?? null,
      angle: screen.orientation?.angle ?? null,
    },
    media: { anyPointerFine: media("(any-pointer: fine)"), anyPointerCoarse: media("(any-pointer: coarse)"), anyHover: media("(any-hover: hover)") },
    userAgentData: uad ? { platform: uad.platform, mobile: uad.mobile, brands: uad.brands.map((b) => `${b.brand} ${b.version}`) } : null,
  };
}

/** A surface element's transform snapshot; the view adds its zoom, page size and canvas. */
export function surfaceTransform(el: HTMLElement | null, zoom: number, pageWidth: number, pageHeight: number, canvas: HTMLCanvasElement | null): TransformInput {
  const r = el?.getBoundingClientRect();
  const vv = window.visualViewport;
  return {
    rect: { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 },
    zoom,
    pageWidth,
    pageHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visualViewport: vv ? { offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, pageLeft: vv.pageLeft, pageTop: vv.pageTop, width: vv.width, height: vv.height, scale: vv.scale } : null,
    canvas: canvas ? { cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, width: canvas.width, height: canvas.height } : null,
  };
}
