import { afterEach, expect, it, vi } from "vitest";

// Rendering switches in the sync debug menu: stored per device, applied on the next load.

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function storage(values: Record<string, string>) {
  const map = new Map(Object.entries(values));
  vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) });
  return map;
}

it("defaults: per-section scaling and quarter steps on, the lazy drawing layer off", async () => {
  storage({});
  const { renderFlag } = await import("@/lib/render-flags");
  expect([renderFlag("sectionScale"), renderFlag("quarterSteps"), renderFlag("lazyOverlay")]).toEqual([true, true, false]);
});

it("reads stored switches, and a change waits for the next load", async () => {
  const map = storage({ "padsync.render.sectionScale": "0" });
  const { renderFlag, setRenderFlag, storedRenderFlag } = await import("@/lib/render-flags");
  expect(renderFlag("sectionScale")).toBe(false);
  setRenderFlag("sectionScale", true);
  expect(map.get("padsync.render.sectionScale")).toBe("1");
  expect(storedRenderFlag("sectionScale")).toBe(true);
  expect(renderFlag("sectionScale")).toBe(false);
});

it("reports the switches in the debug stats", async () => {
  storage({ "padsync.render.lazyOverlay": "1" });
  await import("@/lib/render-flags");
  const { readDebugProbes } = await import("@/lib/sync-debug");
  expect(readDebugProbes()["Render flags"]).toEqual({ sectionScale: true, quarterSteps: true, lazyOverlay: true });
});
