import { execFile } from "node:child_process";

// Timers stop while the Mac sleeps, so a tick that comes late means it has just woken. Power Nap
// wakes a sleeping Mac for a minute or so every quarter of an hour, and reaching padSync then wakes
// its Neon database each time, which kept it from ever scaling to zero overnight. So after a wake
// the bridge stays quiet until the Mac has been up for STEADY_MS, or someone is using it.

export const STEADY_MS = 2 * 60_000;
const TICK_MS = 5000;
/** A gap between ticks this long means the Mac slept through it. */
const SLEPT_MS = 30_000;
/** Keyboard or trackpad input this recent means someone is at the Mac, not a dark wake. */
const USER_IDLE_MS = 60_000;

export function watchWake(o: { now?: () => number; userActive?: () => Promise<boolean>; tickMs?: number } = {}) {
  const now = o.now ?? Date.now;
  const userActive = o.userActive ?? hidActive;
  const tickMs = o.tickMs ?? TICK_MS;
  let lastTick = now();
  // Starting the bridge is deliberate (a login, a restart), not a dark wake.
  let awakeSince = -Infinity;
  const sinceWake = () => {
    const t = now();
    if (t - lastTick > SLEPT_MS) awakeSince = t;
    lastTick = t;
    return t - awakeSince;
  };
  const timer = setInterval(sinceWake, tickMs);
  timer.unref?.();
  return {
    sinceWake,
    /** Resolves once the Mac has stayed awake STEADY_MS since it last woke, or someone is using it. */
    async steady(signal?: AbortSignal) {
      while (sinceWake() < STEADY_MS) {
        if (signal?.aborted) throw signal.reason;
        if (await userActive()) return;
        await new Promise((r) => setTimeout(r, Math.min(tickMs, Math.max(0, STEADY_MS - sinceWake()))));
      }
    },
    stop: () => clearInterval(timer),
  };
}

/** Whether the Mac had keyboard or trackpad input in the last minute (IOKit's HIDIdleTime, in ns). */
function hidActive(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"], { timeout: 2000 }, (error, stdout) => {
      const ns = Number(/"HIDIdleTime" = (\d+)/.exec(stdout ?? "")?.[1]);
      resolve(!error && Number.isFinite(ns) && ns / 1e6 < USER_IDLE_MS);
    });
  });
}
