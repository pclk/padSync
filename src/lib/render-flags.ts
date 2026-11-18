import { registerDebugProbe } from "./sync-debug";

// Rendering switches for finding an iPad rendering bug on the device itself, from the sync debug
// menu. Read once per page load (a reload applies a change), stored per device.

export const RENDER_FLAGS = {
  sectionScale: { label: "Scale each section separately (not the whole notebook)", initial: true },
  quarterSteps: { label: "Ink and PDF resolution in quarter steps (not half steps / tiers)", initial: true },
  lazyOverlay: { label: "Free the live drawing layer when idle", initial: false },
} as const;
export type RenderFlag = keyof typeof RENDER_FLAGS;

const key = (flag: RenderFlag) => `padsync.render.${flag}`;
const loaded = new Map<RenderFlag, boolean>();

export function renderFlag(flag: RenderFlag): boolean {
  let v = loaded.get(flag);
  if (v === undefined) {
    v = RENDER_FLAGS[flag].initial;
    try {
      const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key(flag));
      if (raw === "1" || raw === "0") v = raw === "1";
    } catch { /* default */ }
    loaded.set(flag, v);
  }
  return v;
}

/** Changes the running page's value (tests). */
export function overrideRenderFlag(flag: RenderFlag, value: boolean) {
  loaded.set(flag, value);
}

registerDebugProbe("Render flags", () => Object.fromEntries((Object.keys(RENDER_FLAGS) as RenderFlag[]).map((f) => [f, renderFlag(f)])));

/** Saved for the next load; the running page keeps what it started with. */
export function setRenderFlag(flag: RenderFlag, value: boolean) {
  try {
    localStorage.setItem(key(flag), value ? "1" : "0");
  } catch { /* storage unavailable */ }
}

export function storedRenderFlag(flag: RenderFlag): boolean {
  try {
    const raw = localStorage.getItem(key(flag));
    if (raw === "1" || raw === "0") return raw === "1";
  } catch { /* default */ }
  return RENDER_FLAGS[flag].initial;
}
