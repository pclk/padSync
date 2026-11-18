import { isInking } from "./activity";
import { getSyncTiming } from "./sync";
import { recordInputAnomaly, type DebugValue } from "./sync-debug";

// Sync debug only: catches the iPad page "not accepting input" in the act. Either the main thread
// is busy (frames stop, input waits) or input arrives and goes nowhere (the browser cancels the
// Pencil, a stylus touch stays listed after it lifted, a Pencil press starts no stroke). Each
// record carries what sync and realtime were doing at that moment.

/** A frame gap or input delay this long is felt as the page not responding. */
export const STALL_MS = 200;

function context(): Record<string, DebugValue> {
  const t = getSyncTiming();
  return { realtime: t.realtimeStatus, sync: t.status, requestRunning: t.running, inking: isInking() };
}

const where = (target: EventTarget | null) => {
  const el = target instanceof Element ? target : null;
  return el?.closest(".ink-grab") ? "selection" : el?.closest(".ink-surface") ? "page" : el?.closest("button, input, textarea, a") ? "control" : el ? el.tagName.toLowerCase() : "none";
};

export function startInputWatch() {
  let frame = 0;
  let last = 0;
  // Frames stop while hidden; a gap spanning a hide is not a stall.
  const reset = () => { last = 0; };
  const tick = (t: number) => {
    if (last && document.visibilityState === "visible" && t - last > STALL_MS) {
      recordInputAnomaly("Main thread stalled (no frames)", { ms: t - last, ...context() });
    }
    last = document.visibilityState === "visible" ? t : 0;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const pensDown = new Set<number>();
  // How long an input event waited before any script saw it: the main thread was busy.
  const delay = (e: Event) => {
    const ms = performance.now() - e.timeStamp;
    if (ms > STALL_MS && ms < 60_000) recordInputAnomaly("Input waited for the main thread", { event: e.type, ms, on: where(e.target), ...context() });
  };
  const down = (e: PointerEvent) => {
    delay(e);
    if (e.pointerType !== "pen") return;
    pensDown.add(e.pointerId);
    const on = where(e.target);
    if (on !== "page" && on !== "selection") return;
    // The editor's own handler runs after this capture listener; check once it has.
    setTimeout(() => {
      if (pensDown.has(e.pointerId) && !isInking()) recordInputAnomaly("Pencil down on the page but no stroke started", { on, tool: storedTool(), ...context() });
    }, 0);
  };
  const up = (e: PointerEvent) => {
    pensDown.delete(e.pointerId);
    if (e.type === "pointercancel") recordInputAnomaly("Browser cancelled the pointer", { pointer: e.pointerType, on: where(e.target), ...context() });
  };
  const touch = (e: TouchEvent) => {
    delay(e);
    const changed = new Set([...e.changedTouches].map((t) => t.identifier));
    const stale = [...e.touches].filter((t) => t.touchType === "stylus" && !changed.has(t.identifier));
    if (stale.length && !pensDown.size) recordInputAnomaly("Stylus touch still listed after the Pencil lifted", { touches: e.touches.length, stale: stale.length, on: where(e.target), ...context() });
  };

  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", down, opts);
  window.addEventListener("pointerup", up, opts);
  window.addEventListener("pointercancel", up, opts);
  window.addEventListener("touchstart", touch, opts);
  document.addEventListener("visibilitychange", reset);
  window.addEventListener("pageshow", reset);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointerdown", down, opts);
    window.removeEventListener("pointerup", up, opts);
    window.removeEventListener("pointercancel", up, opts);
    window.removeEventListener("touchstart", touch, opts);
    document.removeEventListener("visibilitychange", reset);
    window.removeEventListener("pageshow", reset);
  };
}

function storedTool(): string {
  try {
    return (JSON.parse(localStorage.getItem("padsync.tool") ?? "{}") as { kind?: string }).kind ?? "pen";
  } catch {
    return "unknown";
  }
}
