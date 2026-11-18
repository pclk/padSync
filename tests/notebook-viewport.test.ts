import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelWidth } from "@/lib/layout-mode";
import {
  MAX_ZOOM,
  MIN_NOTEBOOK_VIEW,
  MIN_ZOOM,
  RAIL_INSET,
  SIDEBAR_W,
  TOOLBAR_H,
  clampZoom,
  columnLayout,
  fitZoom,
  gutterFor,
  overlayInsets,
  pinchPlacement,
  revealRange,
  toolbarVariant,
  verticalPadding,
  type Insets,
  type PinchStart,
} from "@/lib/notebook-viewport";
import { PAGE_WIDTH, type DeviceKind, type StrokeData, type StrokeEntity } from "@/lib/types";

// The page must never be trapped under the header, the iPad rail, the Mac sidebar or the side
// panel: at any zoom from 25% up, panning has to bring every edge into the clear strip.

describe("zoom limits", () => {
  it("goes down to 25% and up to 300%", () => {
    expect(MIN_ZOOM).toBe(0.25);
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(0.25)).toBe(0.25);
    expect(clampZoom(0.3)).toBe(0.3);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
  });

  it("fits the page to the clear strip, never above 100% or below 25%", () => {
    const wide = overlayInsets({ kind: "desktop", sidebarOpen: false, panelWidth: 0 });
    expect(fitZoom(3000, wide, 16, PAGE_WIDTH)).toBe(1);
    const tight = overlayInsets({ kind: "desktop", sidebarOpen: true, panelWidth: 1200 });
    expect(fitZoom(1440, tight, 16, PAGE_WIDTH)).toBe(MIN_ZOOM);
    const half = overlayInsets({ kind: "desktop", sidebarOpen: true, panelWidth: 720 });
    expect(fitZoom(1440, half, 16, PAGE_WIDTH)).toBeCloseTo((1440 - 720 - SIDEBAR_W.expanded - 32) / PAGE_WIDTH);
  });
});

describe("toolbar per device", () => {
  it("keeps the floating rail on the iPad and docks a sidebar on the Mac", () => {
    expect(toolbarVariant("ipad")).toBe("rail");
    expect(toolbarVariant("desktop")).toBe("sidebar");
  });

  it("insets the iPad by the rail whatever the stored sidebar state", () => {
    for (const sidebarOpen of [true, false]) {
      expect(overlayInsets({ kind: "ipad", sidebarOpen, panelWidth: 0 })).toEqual({ top: TOOLBAR_H, right: 0, bottom: 0, left: RAIL_INSET });
    }
  });

  it("insets the Mac by the sidebar, expanded or collapsed, and the panel", () => {
    expect(overlayInsets({ kind: "desktop", sidebarOpen: true, panelWidth: 500 })).toEqual({ top: TOOLBAR_H, right: 500, bottom: 0, left: SIDEBAR_W.expanded });
    expect(overlayInsets({ kind: "desktop", sidebarOpen: false, panelWidth: 0 }).left).toBe(SIDEBAR_W.collapsed);
  });
});

describe("panel width beside the notebook", () => {
  it("keeps the 50/50 and 25/75 split where the window has room", () => {
    expect(panelWidth("drawing", 1440)).toBe(720);
    expect(panelWidth("chat", 2560)).toBe(1920);
    expect(panelWidth("chat", 1440)).toBe(1440 - MIN_NOTEBOOK_VIEW);
    expect(panelWidth("chat", 1440, SIDEBAR_W.expanded)).toBe(1440 - SIDEBAR_W.expanded - MIN_NOTEBOOK_VIEW);
    expect(panelWidth("drawing", 901)).toBe(451);
  });

  it("leaves a whole 25% page beside chat with the sidebar either way", () => {
    for (const vw of [1280, 1440, 1512, 1728, 1920]) {
      for (const sidebarOpen of [true, false]) {
        const left = sidebarOpen ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed;
        const w = panelWidth("chat", vw, left);
        expect(vw - left - w).toBeGreaterThanOrEqual(MIN_NOTEBOOK_VIEW);
        const insets = overlayInsets({ kind: "desktop", sidebarOpen, panelWidth: w });
        const zoom = fitZoom(vw, insets, gutterFor("desktop"), PAGE_WIDTH);
        expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
        // Fitted, the whole page shows and nothing pans sideways.
        expect(columnLayout(vw, PAGE_WIDTH * zoom, insets, gutterFor("desktop")).maxScrollX).toBe(0);
      }
    }
  });

  it("still gives the panel a usable width in a narrow window", () => {
    expect(panelWidth("chat", 800)).toBe(800 - MIN_NOTEBOOK_VIEW);
    expect(panelWidth("chat", 600, SIDEBAR_W.expanded)).toBe(320);
    expect(panelWidth("drawing", 500, SIDEBAR_W.expanded)).toBe(250);
  });
});

type Case = { kind: DeviceKind; vw: number; vh: number; sidebarOpen: boolean; panel: "closed" | "drawing" | "chat"; zoom: number };
function cases(): Case[] {
  const out: Case[] = [];
  const zooms = [MIN_ZOOM, 0.4, 0.5, 0.75, 1, 1.5, 2, MAX_ZOOM];
  for (const vw of [1024, 1280, 1440, 1728])
    for (const sidebarOpen of [true, false])
      for (const panel of ["closed", "drawing", "chat"] as const)
        for (const zoom of zooms) out.push({ kind: "desktop", vw, vh: 860, sidebarOpen, panel, zoom });
  // iPad Pro 13" landscape and portrait, iPad Air 11" landscape; the iPad panel is 360 px.
  for (const [vw, vh] of [[1376, 1032], [1032, 1376], [1180, 820]])
    for (const panel of ["closed", "drawing"] as const)
      for (const zoom of zooms) out.push({ kind: "ipad", vw, vh, sidebarOpen: true, panel, zoom });
  return out;
}
function setup(c: Case) {
  const left = c.kind === "desktop" ? (c.sidebarOpen ? SIDEBAR_W.expanded : SIDEBAR_W.collapsed) : 0;
  const pw = c.panel === "closed" ? 0 : c.kind === "ipad" ? 360 : panelWidth(c.panel, c.vw, left);
  const insets: Insets = overlayInsets({ kind: c.kind, sidebarOpen: c.sidebarOpen, panelWidth: pw });
  const gutter = gutterFor(c.kind);
  const pageW = PAGE_WIDTH * c.zoom;
  return { insets, gutter, pageW, layout: columnLayout(c.vw, pageW, insets, gutter) };
}
const label = (c: Case) => `${c.kind} ${c.vw}x${c.vh} sidebar:${c.sidebarOpen} panel:${c.panel} zoom:${c.zoom}`;

describe("pan bounds", () => {
  it("brings every column of the page into the clear strip", () => {
    for (const c of cases()) {
      const { insets, pageW, layout } = setup(c);
      for (let x = 0; x <= pageW; x += Math.max(4, pageW / 64)) {
        expect(revealRange(layout.left + x, layout, c.vw, insets), `${label(c)} x=${x}`).not.toBeNull();
      }
      expect(revealRange(layout.left + pageW, layout, c.vw, insets), `${label(c)} right edge`).not.toBeNull();
    }
  });

  it("clears the left tools at rest and the right panel at full scroll, with a gutter", () => {
    for (const c of cases()) {
      const { insets, gutter, pageW, layout } = setup(c);
      // Scrolled fully left: the left edge sits right of the rail or sidebar.
      expect(layout.left, label(c)).toBeGreaterThanOrEqual(insets.left);
      // Scrolled fully right: the right edge sits left of the side panel.
      expect(layout.left + pageW - layout.maxScrollX, label(c)).toBeLessThanOrEqual(c.vw - insets.right);
      if (layout.maxScrollX > 0) {
        expect(layout.left - insets.left).toBe(gutter);
        expect(c.vw - insets.right - (layout.left + pageW - layout.maxScrollX)).toBeCloseTo(gutter);
      }
    }
  });

  it("centres a page that fits and does not let it pan sideways", () => {
    for (const c of cases()) {
      const { insets, gutter, pageW, layout } = setup(c);
      if (pageW + 2 * gutter > c.vw - insets.left - insets.right) continue;
      expect(layout.maxScrollX).toBe(0);
      expect(layout.contentWidth).toBe(c.vw);
      expect(layout.left - insets.left).toBeCloseTo(c.vw - insets.right - (layout.left + pageW));
    }
  });

  it("leaves room above the first page and below the last to clear the header", () => {
    for (const c of cases()) {
      const { insets, gutter } = setup(c);
      const v = verticalPadding(insets, gutter);
      expect(v.top).toBe(TOOLBAR_H + gutter);
      // The last page's bottom edge can scroll up to mid-screen, well clear of anything at the bottom.
      const bottom = Math.max(c.vh * v.bottomShare, v.bottomMin);
      expect(bottom).toBeGreaterThanOrEqual(insets.bottom + gutter);
      expect(bottom).toBeGreaterThanOrEqual(c.vh / 2);
    }
  });

  it("frees the strip of the iPad page that the rail used to cover", () => {
    const { insets, layout } = setup({ kind: "ipad", vw: 1376, vh: 1032, sidebarOpen: true, panel: "closed", zoom: 1 });
    expect(layout.left).toBeGreaterThanOrEqual(RAIL_INSET);
    expect(revealRange(layout.left + PAGE_WIDTH, layout, 1376, insets)).not.toBeNull();
  });
});

// Live ink maps client points through each section's own rect, so where the column sits (centred,
// gutter-offset, scrolled sideways) must not move the stored stroke.
const store = vi.hoisted(() => ({
  putEntities: vi.fn(async (rows: StrokeEntity[]) => rows.map((r) => ({ ...r, hlc: "h1" }))),
  newEntity: (kind: string, notebookId: string, parentId: string, data: unknown) => ({ id: `s${Math.random()}`, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 }),
  logEvent: vi.fn(async () => {}),
  setDeleted: vi.fn(async () => {}),
  moveStrokes: vi.fn(async () => {}),
}));
vi.mock("@/lib/store", () => store);
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "dev" }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));

describe("ink coordinates under the new layout", () => {
  beforeEach(() => {
    store.putEntities.mockClear();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("window", { devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900 });
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} quadraticCurveTo() {} arc() {} closePath() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores the same page points at any zoom, panel and pan position", async () => {
    const { InkController } = await import("@/ink/controller");
    const tool = { kind: "pen" as const, penColor: "#000", penSize: 3, hlColor: "#ff0", hlSize: 20, eraserSize: 20 };
    const page = [[40, 30], [700, 120], [PAGE_WIDTH - 10, 400]];
    const combos: Case[] = [
      { kind: "desktop", vw: 1440, vh: 900, sidebarOpen: true, panel: "chat", zoom: MIN_ZOOM },
      { kind: "desktop", vw: 1440, vh: 900, sidebarOpen: false, panel: "drawing", zoom: 1.5 },
      { kind: "ipad", vw: 1376, vh: 1032, sidebarOpen: true, panel: "closed", zoom: 1 },
      { kind: "ipad", vw: 1032, vh: 1376, sidebarOpen: true, panel: "drawing", zoom: 2 },
    ];
    for (const c of combos) {
      const { layout } = setup(c);
      for (const scrollX of [0, layout.maxScrollX]) {
        store.putEntities.mockClear();
        const ctrl = new InkController("nb", tool, { onSelection() {}, onDragging() {}, onTextCreate() {} });
        ctrl.configure(tool, c.zoom);
        const top = 200 - 3000 * c.zoom; // a section well down the notebook, scrolled into view
        const el = { getBoundingClientRect: () => ({ left: layout.left - scrollX, top }), setPointerCapture() {} } as unknown as HTMLElement;
        const sec = { id: "sec", el, strokes: () => [] };
        const ev = (type: string, [x, y]: number[], t: number) =>
          ({ type, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, clientX: layout.left - scrollX + x * c.zoom, clientY: top + y * c.zoom, pressure: 0.5, timeStamp: t, preventDefault() {} }) as unknown as PointerEvent;
        ctrl.down(ev("pointerdown", page[0], 100), sec);
        ctrl.move(ev("pointermove", page[1], 120), sec);
        ctrl.move(ev("pointermove", page[2], 140), sec);
        ctrl.up(ev("pointerup", page[2], 141));
        await vi.waitFor(() => expect(store.putEntities).toHaveBeenCalledTimes(1));
        const data = store.putEntities.mock.calls[0][0][0].data as StrokeData;
        const xy = [0, 6, 12].map((i) => [data.pts[i], data.pts[i + 1]]);
        xy.forEach(([x, y], i) => {
          expect(x, `${label(c)} scroll ${scrollX}`).toBeCloseTo(page[i][0], 1);
          expect(y).toBeCloseTo(page[i][1], 1);
        });
      }
    }
  });
});

describe("toolbar markup per device", () => {
  const tool = { kind: "pen" as const, penColor: "#111827", penSize: 2.2, hlColor: "#facc15", hlSize: 14, eraserSize: 12 };
  const render = async (extra: Record<string, unknown>) => {
    const { Toolbar } = await import("@/components/Toolbar");
    const base = { title: "t", tool, setTool() {}, canUndo: true, canRedo: false, onUndo() {}, onRedo() {}, zoom: 0.25, onZoomReset() {}, panelOpen: false, onTogglePanel() {} };
    return renderToStaticMarkup(createElement(Toolbar, { ...base, ...extra }));
  };

  it("keeps the iPad's floating rail exactly as it was", async () => {
    const html = await render({});
    expect(html).toContain(
      'class="tool-rail fixed left-3 top-1/2 z-40 flex max-h-[calc(100dvh-5rem)] -translate-y-1/2 flex-col items-center gap-2 overflow-y-auto rounded-2xl border border-slate-200/80 bg-white/90 p-1.5 shadow-lift backdrop-blur-md"',
    );
    expect(html).not.toContain("tool-sidebar");
    expect(html).toContain(">25%<");
  });

  it("docks a labelled sidebar on the Mac that collapses to icons", async () => {
    const open = await render({ variant: "sidebar", sidebarOpen: true });
    expect(open).not.toContain("tool-rail");
    expect(open).toContain('data-state="expanded"');
    expect(open).toContain(`width:${SIDEBAR_W.expanded}px`);
    expect(open).toContain('aria-label="Collapse tools"');
    for (const label of ["Pen", "Highlighter", "Eraser", "Lasso", "Text"]) expect(open).toContain(`>${label}</span>`);
    expect(open).toContain('aria-label="Color #1d4ed8"');

    const closed = await render({ variant: "sidebar", sidebarOpen: false });
    expect(closed).toContain('data-state="collapsed"');
    expect(closed).toContain(`width:${SIDEBAR_W.collapsed}px`);
    expect(closed).toContain('aria-label="Expand tools"');
    expect(closed).not.toContain(">Pen</span>");
    // Tools and undo/redo stay one click away while collapsed.
    for (const label of ["Pen", "Highlighter", "Eraser", "Lasso", "Text", "Undo", "Redo"]) expect(closed).toContain(`aria-label="${label}"`);
  });
});

describe("pinch placement", () => {
  // iPad Pro 13" landscape, drawing panel closed: a 100% page is wider than the clear strip.
  const vw = 1376;
  const insets = overlayInsets({ kind: "ipad", sidebarOpen: false, panelWidth: 0 });
  const gutter = gutterFor("ipad");
  // A pinch started with the window scrolled to (sx, sy); the column sits where columnLayout says.
  const startAt = (zoom: number, sx: number, sy: number, anchor: [number, number]): PinchStart => {
    const col = columnLayout(vw, PAGE_WIDTH * zoom, insets, gutter);
    const top = verticalPadding(insets, gutter).top;
    const scaledHeight = 20 * 1032 * zoom;
    return { zoom, left: col.left - sx, top: top - sy, scrollX: sx, scrollY: sy, maxScrollY: top + scaledHeight + 600 - 1024, scaledHeight, anchor, viewportW: vw, insets, gutter };
  };
  // Where the point first under the fingers ends up on screen.
  const anchorAfter = (p: PinchStart, s: number, mid: [number, number]) => {
    const r = pinchPlacement(p, s, mid);
    const k = r.zoom / p.zoom;
    return [r.left + (p.anchor[0] - p.left) * k, r.top + (p.anchor[1] - p.top) * k];
  };

  it("keeps the point under the fingers there while zooming and panning in open space", () => {
    const p = startAt(1, 46, 4000, [700, 500]);
    for (const [s, mid] of [[1.5, [700, 500]], [1.2, [650, 560]], [1.1, [720, 480]]] as [number, [number, number]][]) {
      const [x, y] = anchorAfter(p, s, mid);
      expect(x).toBeCloseTo(mid[0]);
      expect(y).toBeCloseTo(mid[1]);
    }
  });

  it("agrees with the column layout and scroll at the new zoom", () => {
    const p = startAt(1, 46, 4000, [700, 500]);
    const r = pinchPlacement(p, 1.5, [700, 500]);
    const col = columnLayout(vw, PAGE_WIDTH * 1.5, insets, gutter);
    expect(r.zoom).toBe(1.5);
    expect(r.left).toBeCloseTo(col.left - r.scrollX);
    expect(r.scrollX).toBeGreaterThanOrEqual(0);
    expect(r.scrollX).toBeLessThanOrEqual(col.maxScrollX);
  });

  it("stops at the side pan limits instead of jumping there on commit", () => {
    const col = columnLayout(vw, PAGE_WIDTH * 2, insets, gutter);
    // Scrolled fully left, dragging right: the page stays clear of the rail.
    const left = pinchPlacement(startAt(2, 0, 4000, [400, 500]), 1, [700, 500]);
    expect(left.scrollX).toBe(0);
    expect(left.left).toBe(col.left);
    // Scrolled fully right, dragging left: the page's right edge stays at the window edge less the gutter.
    const right = pinchPlacement(startAt(2, col.maxScrollX, 4000, [900, 500]), 1, [500, 500]);
    expect(right.scrollX).toBe(col.maxScrollX);
    expect(right.left + PAGE_WIDTH * 2).toBeCloseTo(vw - gutter);
  });

  it("centres a page zoomed out to fit, wherever the fingers are", () => {
    const r = pinchPlacement(startAt(1, 46, 4000, [300, 500]), 0.5, [300, 500]);
    const col = columnLayout(vw, PAGE_WIDTH * 0.5, insets, gutter);
    expect(col.maxScrollX).toBe(0);
    expect(r.scrollX).toBe(0);
    expect(r.left).toBe(col.left);
  });

  it("stops at the top and the bottom of the notebook", () => {
    const top = pinchPlacement(startAt(1, 0, 0, [700, 300]), 1, [700, 600]);
    expect(top.scrollY).toBe(0);
    expect(top.top).toBe(verticalPadding(insets, gutter).top);
    const p = startAt(1, 0, 0, [700, 300]);
    const bottom = pinchPlacement({ ...p, scrollY: p.maxScrollY, top: p.top - p.maxScrollY }, 0.5, [700, 100]);
    // Zoomed out to half, the scalable column is half as tall and the scroll range shrinks with it.
    expect(bottom.scrollY).toBeCloseTo(p.maxScrollY - p.scaledHeight / 2);
  });

  it("only pans at the zoom limits", () => {
    const p = startAt(MAX_ZOOM, 1000, 4000, [700, 500]);
    const r = pinchPlacement(p, 1.4, [760, 520]);
    expect(r.zoom).toBe(MAX_ZOOM);
    expect(r.scrollX).toBeCloseTo(1000 - 60);
    expect(r.scrollY).toBeCloseTo(4000 - 20);
    expect(pinchPlacement(startAt(MIN_ZOOM, 0, 4000, [700, 500]), 0.5, [700, 500]).zoom).toBe(MIN_ZOOM);
  });
});
