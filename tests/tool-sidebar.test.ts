import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolState } from "@/ink/controller";
import { notebookViewportWidth, panelWidth, TOOL_SIDEBAR_W } from "@/lib/layout-mode";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));

const { Toolbar } = await import("@/components/Toolbar");
const { deviceKind } = await import("@/lib/db");

const tool: ToolState = { kind: "highlighter", penColor: "#111827", penSize: 3.4, hlColor: "#facc15", hlSize: 22, eraserSize: 24 };
const props = { title: "Notes", tool, setTool: () => {}, canUndo: true, canRedo: false, onUndo: () => {}, onRedo: () => {}, zoom: 0.5, onZoomReset: () => {}, panelOpen: true, onTogglePanel: () => {} };
const render = (sidebar?: { open: boolean; onToggle: () => void }) => renderToStaticMarkup(createElement(Toolbar, { ...props, sidebar }));
const toolButtons = (html: string) => ["Pen", "Highlighter", "Eraser", "Lasso", "Text", "Undo", "Redo"].filter((l) => html.includes(`aria-label="${l}"`));

describe("Mac drawing-tools sidebar", () => {
  it("docks the tools with a toggle that reports its state", () => {
    const html = render({ open: true, onToggle: () => {} });
    expect(html).toContain('aria-controls="drawing-tools"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("tool-sidebar");
    expect(html).not.toContain("inert");
    expect(toolButtons(html)).toHaveLength(7);
  });

  it("keeps the toggle and the selected tool when collapsed, and takes hidden tools out of reach", () => {
    const html = render({ open: false, onToggle: () => {} });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="Show drawing tools"');
    expect(html).toContain('aria-label="Highlighter selected"');
    expect(html).toMatch(/<aside[^>]*inert/);
    expect(html).toContain("-translate-x-full");
    // Still mounted, so selected tool, colour and size render the same on reopen.
    expect(toolButtons(html)).toHaveLength(7);
    expect(html).toMatch(/aria-label="Highlighter" aria-pressed="true"/);
  });

  it("leaves the iPad's floating rail as it was, with no sidebar toggle", () => {
    const html = render();
    expect(html).not.toContain("aria-controls=\"drawing-tools\"");
    expect(html).not.toContain("tool-sidebar");
    expect(html).toContain("tool-rail fixed left-3 top-1/2");
    expect(html).not.toMatch(/<aside[^>]*inert/);
  });
});

describe("notebook viewport", () => {
  it("subtracts the sidebar together with the chat or drawing panel", () => {
    expect(notebookViewportWidth(1440, panelWidth("drawing", 1440), TOOL_SIDEBAR_W)).toBe(1440 - 720 - 64 - 32);
    expect(notebookViewportWidth(1440, panelWidth("chat", 1440), TOOL_SIDEBAR_W)).toBe(1440 - 1080 - 64 - 32);
    expect(notebookViewportWidth(1440, panelWidth("chat", 1440), 0)).toBe(1440 - 1080 - 32);
    expect(notebookViewportWidth(300, 600, TOOL_SIDEBAR_W)).toBe(0);
  });
});

describe("device classification", () => {
  afterEach(() => vi.unstubAllGlobals());
  const as = (userAgent: string, platform: string, maxTouchPoints: number) => vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });

  it("treats an iPad requesting the desktop site as an iPad, whatever its width", () => {
    as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel", 5);
    expect(deviceKind()).toBe("ipad");
    as("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15", "iPad", 5);
    expect(deviceKind()).toBe("ipad");
  });

  it("treats a Mac as a desktop", () => {
    as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel", 0);
    expect(deviceKind()).toBe("desktop");
  });
});
