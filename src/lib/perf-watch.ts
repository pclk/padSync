import { db } from "./db";
import { getSyncTiming } from "./sync";
import { countDebug, observeDebug, recordDebugError, recordDebugSample, type DebugValue } from "./sync-debug";

// Sync debug only: resource use and runtime health, sampled while the menu is on. Everything is
// metadata (sizes, counts, timings); no notebook content is read. iPad Safari exposes no JS heap or
// GPU numbers, so canvas and decoded image pixels stand in for graphics memory there.

const MB = 1048576;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Live resource numbers, read for the panel and the report. */
export type ResourceSnapshot = Record<string, DebugValue>;
let latest: ResourceSnapshot = {};
let storage: ResourceSnapshot = {};
let database: ResourceSnapshot = {};
export const getResourceSnapshot = () => ({ ...latest, ...storage, ...database });

type PerfMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };

/** Graphics memory stand-ins: every canvas backing store and every decoded image on the page. */
export function measureDom(doc: Document = document): ResourceSnapshot {
  let canvasBytes = 0, largest = 0, canvases = 0;
  for (const c of doc.getElementsByTagName("canvas")) {
    const px = c.width * c.height;
    if (!px) continue;
    canvases++;
    canvasBytes += px * 4;
    largest = Math.max(largest, px);
  }
  let imageBytes = 0, images = 0;
  for (const img of doc.images) {
    if (!img.complete || !img.naturalWidth) continue;
    images++;
    imageBytes += img.naturalWidth * img.naturalHeight * 4;
  }
  return {
    "Canvas memory MB": round(canvasBytes / MB),
    "Canvases with a bitmap": canvases,
    "Largest canvas MP": round(largest / 1e6, 2),
    "Decoded image MB": round(imageBytes / MB),
    "Images loaded": images,
    "DOM elements": doc.getElementsByTagName("*").length,
  };
}

export function environment(): string[] {
  try {
    return describeEnvironment();
  } catch (error) {
    return [`Environment unavailable (${error instanceof Error ? error.name : "unknown"})`];
  }
}

function describeEnvironment(): string[] {
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean }; standalone?: boolean };
  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  const lines = [
    `Browser: ${n.userAgent}`,
    `Screen: ${screen.width}×${screen.height} @${window.devicePixelRatio}x · viewport ${window.innerWidth}×${window.innerHeight} · ${screen.orientation?.type ?? "orientation unknown"} · ${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"} · reduced motion ${matchMedia("(prefers-reduced-motion: reduce)").matches ? "on" : "off"}`,
    `Hardware: ${n.hardwareConcurrency ?? "?"} cores · device memory ${n.deviceMemory ? `${n.deviceMemory} GB` : "not exposed"} · touch points ${n.maxTouchPoints} · language ${n.language} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Network: ${n.onLine ? "online" : "offline"}${n.connection ? ` · ${n.connection.effectiveType ?? "?"} · rtt ${n.connection.rtt ?? "?"} ms · ${n.connection.downlink ?? "?"} Mb/s${n.connection.saveData ? " · data saver" : ""}` : " · connection info not exposed"}`,
    `Page: open ${round(performance.now() / 60000)} min · ${nav ? `${nav.type} · first byte ${Math.round(nav.responseStart)} ms · DOM ready ${Math.round(nav.domContentLoadedEventEnd)} ms · load ${Math.round(nav.loadEventEnd)} ms` : "navigation timing unavailable"} · service worker ${navigator.serviceWorker?.controller ? "controlling" : "not controlling"} · ${crossOriginIsolated ? "cross-origin isolated" : "not isolated"}`,
    `Memory API: ${(performance as Performance & { memory?: PerfMemory }).memory ? "JS heap available" : "no JS heap numbers in this browser"} · observers ${supported().join(", ") || "none"}`,
  ];
  return lines;
}

const supported = () => (typeof PerformanceObserver !== "undefined" ? PerformanceObserver.supportedEntryTypes ?? [] : []).filter((t) => ["longtask", "long-animation-frame", "event", "first-input", "layout-shift", "paint"].includes(t));

export function startPerfWatch() {
  const timers: number[] = [];
  const cleanups: (() => void)[] = [];

  // Frames: rate per second and gaps between frames.
  let frame = 0, frames = 0, lastFrame = 0, windowStart = performance.now();
  const tick = (t: number) => {
    if (document.visibilityState === "visible") {
      frames++;
      if (lastFrame) {
        const gap = t - lastFrame;
        observeDebug("Frame interval ms", gap);
        if (gap > 50) countDebug("Frames · gap > 50 ms");
        if (gap > 100) countDebug("Frames · gap > 100 ms");
        if (gap > 500) countDebug("Frames · gap > 500 ms");
      }
      lastFrame = t;
    } else lastFrame = 0;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  cleanups.push(() => cancelAnimationFrame(frame));

  // Event loop lag: how late a 100 ms timer fires.
  let expected = performance.now() + 100;
  timers.push(window.setInterval(() => {
    const now = performance.now();
    if (document.visibilityState === "visible") observeDebug("Event loop lag ms", Math.max(0, now - expected));
    expected = now + 100;
  }, 100));

  // Each second: frame rate, DOM resources, heap, sync and realtime state time.
  let pencilSamples = 0;
  timers.push(window.setInterval(() => {
    const now = performance.now();
    const fps = (frames * 1000) / (now - windowStart);
    if (document.visibilityState === "visible") observeDebug("Frames per second", fps);
    frames = 0; windowStart = now;
    if (pencilSamples) observeDebug("Pencil samples per second (while drawing)", pencilSamples);
    pencilSamples = 0;
    const dom = measureDom();
    const memory = (performance as Performance & { memory?: PerfMemory }).memory;
    latest = {
      ...dom,
      "Frames per second": round(fps),
      ...(memory ? { "JS heap used MB": round(memory.usedJSHeapSize / MB), "JS heap limit MB": round(memory.jsHeapSizeLimit / MB, 0) } : {}),
    };
    for (const [k, v] of Object.entries(latest)) if (typeof v === "number" && k !== "Frames per second") observeDebug(k, v);
    const t = getSyncTiming();
    countDebug(`Seconds · realtime ${t.realtimeStatus}`);
    countDebug(`Seconds · sync ${t.status}`);
    countDebug(`Seconds · page ${document.visibilityState}`);
  }, 1000));

  // Every 5 s: a row of the resource timeline.
  timers.push(window.setInterval(() => {
    const t = getSyncTiming();
    recordDebugSample({ ...latest, realtime: t.realtimeStatus, sync: t.status, visible: document.visibilityState === "visible" });
  }, 5000));

  // Every 15 s: storage use and IndexedDB row counts.
  const slow = async () => {
    try {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      storage = est ? { "Storage used MB": round((est.usage ?? 0) / MB), "Storage quota MB": round((est.quota ?? 0) / MB, 0), "Storage persisted": !!persisted } : {};
    } catch { storage = {}; }
    try {
      const kinds = ["notebook", "section", "stroke", "textbox", "presence"] as const;
      const [total, dirty, events, unsynced, ...perKind] = await Promise.all([
        db.entities.count(), db.entities.where("dirty").equals(1).count(), db.events.count(), db.events.where("synced").equals(0).count(),
        ...kinds.map((k) => db.entities.where("kind").equals(k).count()),
      ]);
      database = { "DB entities": total, ...Object.fromEntries(kinds.map((k, i) => [`DB ${k}s`, perKind[i]])), "DB unsent entities": dirty, "DB events": events, "DB unsent events": unsynced };
    } catch (error) { database = { "DB read failed": error instanceof Error ? error.name : "unknown" }; }
  };
  void slow();
  timers.push(window.setInterval(() => void slow(), 15000));

  // Browser performance entries, where supported (Chromium has most; Safari has few).
  const types = supported();
  if (types.length) {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.entryType === "longtask") { countDebug("Long tasks"); observeDebug("Long task ms", e.duration); }
        else if (e.entryType === "long-animation-frame") { countDebug("Long animation frames"); observeDebug("Long animation frame ms", e.duration); }
        else if (e.entryType === "event" || e.entryType === "first-input") {
          const ev = e as PerformanceEventTiming;
          observeDebug(`Interaction ${ev.name} ms (input to paint)`, ev.duration);
          observeDebug(`Interaction ${ev.name} input delay ms`, ev.processingStart - ev.startTime);
        } else if (e.entryType === "layout-shift") observeDebug("Layout shift", (e as PerformanceEntry & { value: number }).value);
      }
    });
    for (const type of types) {
      if (type === "paint") continue;
      try { po.observe({ type, buffered: false, ...(type === "event" ? { durationThreshold: 16 } : {}) } as PerformanceObserverInit); } catch { /* unsupported option */ }
    }
    cleanups.push(() => po.disconnect());
  }

  // Input: counts, how long events waited, and the Pencil's sample rate.
  const opts = { capture: true, passive: true } as const;
  const onPointer = (e: PointerEvent) => {
    if (e.type === "pointermove") {
      if (e.pointerType === "pen" && e.buttons) pencilSamples += e.getCoalescedEvents?.().length || 1;
      return;
    }
    countDebug(`Input · ${e.type} ${e.pointerType}`);
    const wait = performance.now() - e.timeStamp;
    if (wait >= 0 && wait < 60000) observeDebug(`Input delay ms · ${e.type}`, wait);
  };
  const onOther = (e: Event) => countDebug(`Input · ${e.type}`);
  for (const type of ["pointerdown", "pointerup", "pointercancel", "pointermove"]) window.addEventListener(type, onPointer as EventListener, opts);
  for (const type of ["keydown", "wheel", "gesturestart", "contextmenu", "selectstart"]) window.addEventListener(type, onOther, opts);
  cleanups.push(() => {
    for (const type of ["pointerdown", "pointerup", "pointercancel", "pointermove"]) window.removeEventListener(type, onPointer as EventListener, opts);
    for (const type of ["keydown", "wheel", "gesturestart", "contextmenu", "selectstart"]) window.removeEventListener(type, onOther, opts);
  });

  // Page lifecycle.
  const lifecycle = (e: Event) => countDebug(`Page · ${e.type}${e.type === "visibilitychange" ? ` → ${document.visibilityState}` : ""}`);
  for (const type of ["visibilitychange", "pageshow", "pagehide", "focus", "blur", "online", "offline", "resize", "orientationchange"]) window.addEventListener(type, lifecycle);
  document.addEventListener("visibilitychange", lifecycle);
  cleanups.push(() => {
    for (const type of ["visibilitychange", "pageshow", "pagehide", "focus", "blur", "online", "offline", "resize", "orientationchange"]) window.removeEventListener(type, lifecycle);
    document.removeEventListener("visibilitychange", lifecycle);
  });

  // Errors, rejections and console messages (React reports hydration and render problems there).
  const onError = (e: ErrorEvent) => recordDebugError("error", `${e.message} @ ${(e.filename ?? "").split("/").pop()}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) => recordDebugError("unhandled rejection", e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const original = { error: console.error, warn: console.warn };
  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
  console.error = (...args: unknown[]) => { recordDebugError("console.error", text(args)); original.error.apply(console, args); };
  console.warn = (...args: unknown[]) => { recordDebugError("console.warn", text(args)); original.warn.apply(console, args); };
  cleanups.push(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    console.error = original.error;
    console.warn = original.warn;
  });

  return () => {
    timers.forEach((t) => clearInterval(t));
    cleanups.forEach((fn) => fn());
  };
}
