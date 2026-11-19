import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROMPTS, MAX_PROMPTS, PROMPT_EVENT, normalizePrompts, peekPrompt, queuePrompt, takePrompt } from "@/lib/prompts";
import { DEFAULT_RAIL, normalizeRail, railFloats } from "@/lib/rail-layout";
import { RAIL_INSET, TOOLBAR_H, overlayInsets } from "@/lib/notebook-viewport";
import { fanLayout, pickByDirection } from "@/lib/tool-circle";
import { actionsFor } from "@/lib/touch-gestures";

afterEach(() => vi.unstubAllGlobals());

describe("chat prompts", () => {
  it("comes with ready-made prompts, and mends what was stored", () => {
    expect(normalizePrompts(undefined)).toEqual(DEFAULT_PROMPTS);
    const fixed = normalizePrompts([
      { id: "a", label: "", text: "Hi", icon: "nope" },
      { id: "a", label: "dup", text: "x" },
      { label: "no id", text: "x" },
      { id: "b", label: "Draft", text: "About: ", send: false, icon: "bulb" },
    ]);
    expect(fixed).toEqual([
      { id: "a", label: "Prompt", text: "Hi", send: true, voice: false, context: "chat", icon: "message" },
      { id: "b", label: "Draft", text: "About: ", send: false, voice: false, context: "chat", icon: "bulb" },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, label: "x", text: "x" }));
    expect(normalizePrompts(many)).toHaveLength(MAX_PROMPTS);
  });

  it("hands a picked prompt to the chat once, even if the chat mounts later or is busy", () => {
    const events: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
    queuePrompt(DEFAULT_PROMPTS[0]);
    expect(events).toEqual([PROMPT_EVENT]);
    // A busy composer looks without taking, and takes it once free.
    expect(peekPrompt()).toEqual({ prompt: DEFAULT_PROMPTS[0] });
    expect(takePrompt()).toEqual({ prompt: DEFAULT_PROMPTS[0] });
    expect(takePrompt()).toBe(null);
    const audio = new Blob(["x"], { type: "audio/webm" });
    queuePrompt(DEFAULT_PROMPTS[0], audio);
    expect(takePrompt()?.audio).toBe(audio);
  });

  it("keeps each prompt's context and voice choice, a voice prompt always sending", () => {
    const [p] = normalizePrompts([{ id: "v", label: "Talk", text: "", voice: true, send: false, context: "selection" }]);
    expect(p).toMatchObject({ voice: true, send: true, context: "selection" });
    expect(normalizePrompts([{ id: "x", text: "", context: "sections" }])[0].context).toBe("chat");
    expect(DEFAULT_PROMPTS.some((d) => d.voice)).toBe(true);
  });

  it("can be emptied: no prompts stays no prompts", () => {
    expect(normalizePrompts([])).toEqual([]);
  });

  it("is a toolbar item, added to layouts saved before it existed", () => {
    expect(DEFAULT_RAIL.order).toContain("prompts");
    expect(normalizeRail({ order: ["pen", "text"] }).order).toContain("prompts");
  });

  it("can be opened by any gesture", () => {
    for (const g of ["twoTap", "threeTap", "fourTap", "twoDoubleTap", "fingerDoubleTap", "fingerHold"] as const) {
      expect(actionsFor(g).map((a) => a.action)).toContain("promptMenu");
    }
  });
});

describe("prompt menu layout", () => {
  const vp: [number, number] = [1024, 1366];

  it("makes a full ring around a gesture in the middle of the page, starting at the top", () => {
    const { angles, radius } = fanLayout(6, [512, 683], vp, 56);
    expect(angles.map(Math.round)).toEqual([-90, -30, 30, 90, 150, 210]);
    expect(radius).toBeGreaterThanOrEqual(96);
    // Any direction points at a prompt; staying near the press points at none.
    expect(pickByDirection(angles, 0, -60)).toBe(0);
    expect(pickByDirection(angles, -50, 30)).toBe(4);
    expect(pickByDirection(angles, 5, 5)).toBe(-1);
  });

  it("fans out over half a circle near an edge, wider when there are many prompts", () => {
    const six = fanLayout(6, [44, 683], vp, 56);
    expect(Math.round(six.angles[0])).toBe(-90);
    expect(Math.round(six.angles.at(-1)!)).toBe(90);
    const eight = fanLayout(8, [44, 683], vp, 56);
    expect(eight.radius).toBeGreaterThan(six.radius);
  });
});

const tool = { kind: "pen" as const, penColor: "#111827", penSize: 2.2, hlColor: "#facc15", hlSize: 14, eraserSize: 12 };
async function renderToolbar(rail = DEFAULT_RAIL) {
  const { Toolbar } = await import("@/components/Toolbar");
  return renderToStaticMarkup(createElement(Toolbar, { title: "t", tool, setTool() {}, canUndo: true, canRedo: false, onUndo() {}, onRedo() {}, zoom: 1, onZoomReset() {}, panelOpen: false, onTogglePanel() {}, rail, prompts: DEFAULT_PROMPTS, onPrompt() {} }));
}

describe("prompt button", () => {
  const render = renderToolbar;

  it("sits in the bar, and beside the tool circle, unless hidden", async () => {
    expect(await render()).toContain('aria-label="Chat prompts"');
    expect(await render({ ...DEFAULT_RAIL, style: "circle" })).toContain('aria-label="Chat prompts: tap to choose, or hold and drag towards one"');
    expect(await render({ ...DEFAULT_RAIL, style: "circle", hidden: ["prompts"] })).not.toContain("Chat prompts");
    expect(await render({ ...DEFAULT_RAIL, hidden: ["prompts"] })).not.toContain("Chat prompts");
  });
});

describe("moving the circles", () => {
  it("keeps moved circles' places, inside the window, and drops bad ones", () => {
    const l = normalizeRail({ style: "circle", free: { tools: [1.4, 0.5], prompts: ["a", 2] as never } });
    expect(l.free).toEqual({ tools: [0.97, 0.5] });
    expect(normalizeRail({}).free).toEqual({});
  });

  it("frees the page's edge strip only once no circle is left docked", () => {
    const circle = { ...DEFAULT_RAIL, style: "circle" as const };
    expect(railFloats({ ...circle, free: { tools: [0.5, 0.5] } })).toBe(false);
    expect(railFloats({ ...circle, free: { tools: [0.5, 0.5], prompts: [0.6, 0.5] } })).toBe(true);
    expect(railFloats({ ...circle, hidden: ["prompts"], free: { tools: [0.5, 0.5] } })).toBe(true);
    expect(railFloats({ ...DEFAULT_RAIL, free: { tools: [0.5, 0.5], prompts: [0.6, 0.5] } })).toBe(false);
    expect(overlayInsets({ kind: "ipad", sidebarOpen: false, panelWidth: 360, railFloating: true })).toEqual({ top: TOOLBAR_H, right: 360, bottom: 0, left: 0 });
    expect(overlayInsets({ kind: "ipad", sidebarOpen: false, panelWidth: 0 }).left).toBe(RAIL_INSET);
  });

  it("draws a moved circle where it was put, the other still docked", async () => {
    const html = await renderToolbar({ ...DEFAULT_RAIL, style: "circle", free: { prompts: [0.8, 0.25] } });
    expect(html).toContain('data-placed="prompts"');
    expect(html).toContain("left:80%;top:25%");
    expect(html).not.toContain('data-placed="tools"');
  });
});

describe("prompt settings", () => {
  it("offers moving the circles, and deleting or restoring the prompts", async () => {
    const { RailSettings } = await import("@/components/RailSettings");
    const anchor = { edge: "left" as const, bar: { top: 0, left: 0, right: 60, bottom: 60 }, x: 30, y: 30 };
    const base = { setLayout() {}, anchor, onClose() {}, onArrange() {} };
    const toolbar = renderToStaticMarkup(createElement(RailSettings, { ...base, layout: { ...DEFAULT_RAIL, style: "circle" } }));
    expect(toolbar).toContain("Move circles…");
    expect(renderToStaticMarkup(createElement(RailSettings, { ...base, layout: DEFAULT_RAIL }))).not.toContain("Move circles…");
    const prompts = renderToStaticMarkup(createElement(RailSettings, { ...base, layout: DEFAULT_RAIL, initialTab: "prompts" }));
    expect(prompts).toContain("Delete all");
    expect(prompts).toContain("Restore starters");
    expect(prompts).toContain("Voice message");
  });
});

describe("circle sizes", () => {
  it("keeps each circle's size within its range", async () => {
    const { CIRCLE_SIZES } = await import("@/lib/rail-layout");
    expect(normalizeRail({}).size).toEqual({ tools: 60, prompts: 48 });
    expect(normalizeRail({ size: { tools: 999, prompts: 2 } }).size).toEqual({ tools: CIRCLE_SIZES.tools.max, prompts: CIRCLE_SIZES.prompts.min });
  });

  it("widens the page's clear strip for a bigger docked circle, and not for a moved one", async () => {
    const { railThickness } = await import("@/lib/rail-layout");
    const circle = { ...DEFAULT_RAIL, style: "circle" as const };
    expect(railThickness(DEFAULT_RAIL, RAIL_INSET)).toBe(RAIL_INSET);
    expect(railThickness(circle, RAIL_INSET)).toBe(RAIL_INSET);
    expect(railThickness({ ...circle, size: { tools: 100, prompts: 48 } }, RAIL_INSET)).toBe(116);
    // The big circle moved away: only the docked prompt circle counts.
    expect(railThickness({ ...circle, size: { tools: 100, prompts: 48 }, free: { tools: [0.5, 0.5] } }, RAIL_INSET)).toBe(64);
    expect(overlayInsets({ kind: "ipad", sidebarOpen: false, panelWidth: 0, railInset: 116 }).left).toBe(116);
  });

  it("draws the circles at their sizes", async () => {
    const html = await renderToolbar({ ...DEFAULT_RAIL, style: "circle", size: { tools: 88, prompts: 40 } });
    expect(html).toContain("width:88px;height:88px");
    expect(html).toContain("width:40px;height:40px");
  });
});
