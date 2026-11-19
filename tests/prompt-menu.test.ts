import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROMPTS, MAX_PROMPTS, PROMPT_EVENT, normalizePrompts, queuePrompt, takePrompt } from "@/lib/prompts";
import { DEFAULT_RAIL, normalizeRail } from "@/lib/rail-layout";
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
      { id: "a", label: "Prompt", text: "Hi", send: true, icon: "message" },
      { id: "b", label: "Draft", text: "About: ", send: false, icon: "bulb" },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, label: "x", text: "x" }));
    expect(normalizePrompts(many)).toHaveLength(MAX_PROMPTS);
  });

  it("hands a picked prompt to the chat once, even if the chat mounts later", () => {
    const events: string[] = [];
    vi.stubGlobal("window", { dispatchEvent: (e: Event) => events.push(e.type) });
    queuePrompt(DEFAULT_PROMPTS[0]);
    expect(events).toEqual([PROMPT_EVENT]);
    expect(takePrompt()).toEqual(DEFAULT_PROMPTS[0]);
    expect(takePrompt()).toBe(null);
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

describe("prompt button", () => {
  const tool = { kind: "pen" as const, penColor: "#111827", penSize: 2.2, hlColor: "#facc15", hlSize: 14, eraserSize: 12 };
  const render = async (rail = DEFAULT_RAIL) => {
    const { Toolbar } = await import("@/components/Toolbar");
    return renderToStaticMarkup(createElement(Toolbar, { title: "t", tool, setTool() {}, canUndo: true, canRedo: false, onUndo() {}, onRedo() {}, zoom: 1, onZoomReset() {}, panelOpen: false, onTogglePanel() {}, rail, prompts: DEFAULT_PROMPTS, onPrompt() {} }));
  };

  it("sits in the bar, and beside the tool circle, unless hidden", async () => {
    expect(await render()).toContain('aria-label="Chat prompts"');
    expect(await render({ ...DEFAULT_RAIL, style: "circle" })).toContain('aria-label="Chat prompts: tap to choose, or hold and drag towards one"');
    expect(await render({ ...DEFAULT_RAIL, style: "circle", hidden: ["prompts"] })).not.toContain("Chat prompts");
    expect(await render({ ...DEFAULT_RAIL, hidden: ["prompts"] })).not.toContain("Chat prompts");
  });
});
