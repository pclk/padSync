import { describe, expect, it } from "vitest";
import { buildBundle, DEFAULT_CONTEXT, type SectionInput } from "@/lib/context";
import { readView, spanSectionIds, viewFor, viewFromRects, type ScreenView } from "@/lib/section-span";
import { PAGE_WIDTH, type SectionData } from "@/lib/types";

const ids = ["a", "b", "c"].map((id) => ({ id }));
const view: ScreenView = { slices: [{ sectionId: "b", y0: 800, y1: 1000, h: 1000 }, { sectionId: "c", y0: 0, y1: 300, h: 1200 }], x0: 0, x1: PAGE_WIDTH };

describe("spanSectionIds", () => {
  it("covers the section, a neighbour, or the screen", () => {
    expect(spanSectionIds(ids, "b", "section", null)).toEqual(["b"]);
    expect(spanSectionIds(ids, "b", "above", null)).toEqual(["a", "b"]);
    expect(spanSectionIds(ids, "b", "below", null)).toEqual(["b", "c"]);
    expect(spanSectionIds(ids, "a", "above", null)).toEqual(["a"]);
    expect(spanSectionIds(ids, "c", "below", null)).toEqual(["c"]);
    expect(spanSectionIds(ids, "a", "viewport", view)).toEqual(["b", "c"]);
  });

  it("falls back to the section with no screen to go by", () => {
    expect(spanSectionIds(ids, "b", "viewport", null)).toEqual(["b"]);
    expect(spanSectionIds(ids, "b", "viewport", { ...view, slices: [{ sectionId: "gone", y0: 0, y1: 1 }] })).toEqual(["b"]);
  });

  it("keeps a view only for the screen span", () => {
    expect(viewFor("above", view, ["b"])).toBeNull();
    expect(viewFor("viewport", view, ["c"])?.slices.map((s) => s.sectionId)).toEqual(["c"]);
  });
});

describe("views", () => {
  it("reads only well-formed views from another device", () => {
    expect(readView(null)).toBeNull();
    expect(readView({ slices: [], x0: 0, x1: 10 })).toBeNull();
    expect(readView({ slices: [{ sectionId: "a", y0: 5, y1: 2 }], x0: 0, x1: 10 })).toBeNull();
    expect(readView({ slices: [{ sectionId: "a", y0: 0, y1: 2, h: "x" }], x0: -5, x1: 99999 })).toEqual({ slices: [{ sectionId: "a", y0: 0, y1: 2 }], x0: 0, x1: PAGE_WIDTH });
  });

  it("measures a zoomed, scrolled page from its rectangles", () => {
    const zoom = 2;
    const rect = (top: number, height: number) => ({ top, bottom: top + height * zoom, left: -100, right: PAGE_WIDTH * zoom - 100, width: PAGE_WIDTH * zoom, height: height * zoom }) as DOMRectReadOnly;
    const v = viewFromRects([{ id: "a", rect: rect(-1500, 1000) }, { id: "b", rect: rect(500, 1000) }, { id: "c", rect: rect(3000, 500) }], { top: 0, bottom: 1000, left: 0, right: 1000 });
    expect(v).toEqual({ slices: [{ sectionId: "a", y0: 750, y1: 1000, h: 1000 }, { sectionId: "b", y0: 0, y1: 250, h: 1000 }], x0: 50, x1: 550 });
  });
});

describe("bundle", () => {
  const data = (title: string): SectionData => ({ title, blocks: [], template: "blank" }) as unknown as SectionData;
  const sections: SectionInput[] = ["a", "b", "c"].map((id) => ({ id, data: data(id.toUpperCase()), notes: [], lastActivity: 0 }));

  it("notes what the screen shows", () => {
    const b = buildBundle({ title: "N", sections }, { ...DEFAULT_CONTEXT, scope: "sections", sectionIds: ["b", "c"], renders: false, view });
    const md = b.files.find((f) => f.path === "notebook.md")!.text!;
    expect(b.sectionIds).toEqual(["b", "c"]);
    expect(md).toContain("On my screen right now: section 2 (80% to 100% of the way down), section 3 (0% to 25% of the way down)");
  });
});
