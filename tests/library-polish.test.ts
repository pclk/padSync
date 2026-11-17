import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectNotebooks } from "@/lib/library";
import type { PresenceEntity } from "@/lib/types";
import type { NotebookEntity } from "@/lib/types";

const state = vi.hoisted(() => ({ notebooks: undefined as NotebookEntity[] | undefined, call: 0, counts: undefined as Map<string, number> | undefined, ipad: undefined as PresenceEntity | undefined }));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [state.notebooks, state.counts, state.ipad][state.call++ % 3] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "test" }));
vi.mock("@/lib/store", () => ({ createNotebook: vi.fn(), listNotebooks: vi.fn(), putEntities: vi.fn() }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));
import Library from "@/components/Library";
const nb = (id: string, title: string, createdAt: number) => ({ id, data: { title, createdAt } }) as NotebookEntity;
const notebooks = [nb("b", "Zoology", 10), nb("a", "Algebra", 20), nb("c", "Analysis [1]", 20)];

describe("library selection", () => {
  it("searches trimmed titles case insensitively, treating punctuation literally", () => {
    expect(selectNotebooks(notebooks, "  ALG  ", "newest").map(n => n.id)).toEqual(["a"]);
    expect(selectNotebooks(notebooks, "[1]", "newest").map(n => n.id)).toEqual(["c"]);
    expect(selectNotebooks(notebooks, "missing", "newest")).toEqual([]);
  });
  it("sorts every supported order with stable ties without mutating the source", () => {
    expect(selectNotebooks(notebooks, "", "newest").map(n => n.id)).toEqual(["a", "c", "b"]);
    expect(selectNotebooks(notebooks, "", "oldest").map(n => n.id)).toEqual(["b", "a", "c"]);
    expect(selectNotebooks(notebooks, "", "title").map(n => n.id)).toEqual(["a", "c", "b"]);
    expect(notebooks.map(n => n.id)).toEqual(["b", "a", "c"]);
  });
});

describe("library states and accessible actions", () => {
  beforeEach(() => { state.call = 0; state.notebooks = undefined; state.counts = undefined; state.ipad = undefined; });
  const render = () => renderToStaticMarkup(createElement(Library));
  it("announces loading rather than flashing an empty library", () => {
    expect(render()).toContain('role="status"');
    expect(render()).not.toContain("Start your first notebook");
  });
  it("shows onboarding only for an empty library", () => {
    state.notebooks = [];
    expect(render()).toContain("Start your first notebook");
    expect(render()).not.toContain("Search notebooks");
  });
  it("provides labelled search, sorting and always visible notebook actions", () => {
    state.notebooks = notebooks;
    const html = render();
    expect(html).toContain("Search notebooks");
    expect(html).toContain("Sort by");
    expect(html).toContain('aria-label="Rename Algebra"');
    expect(html).toContain('aria-label="Delete Algebra"');
    expect(html).not.toContain("group-hover:flex");
    expect(html).toContain('href="/notebook?id=a"');
  });
});


describe("independent library rendering regressions", () => {
  beforeEach(() => { state.call = 0; state.notebooks = notebooks; state.counts = undefined; state.ipad = undefined; });
  const render = () => renderToStaticMarkup(createElement(Library));
  it("does not misrepresent unresolved section counts as zero", () => {
    expect(render()).toContain("…");
    expect(render()).not.toContain("0 sections");
  });
  it("distinguishes one section from zero and multiple sections", () => {
    state.counts = new Map([["a", 1], ["b", 2]]);
    const html = render();
    expect(html).toContain("1 section ·");
    expect(html).toContain("2 sections ·");
    expect(html).toContain("0 sections ·");
  });
  it("escapes hostile notebook titles in content and action names", () => {
    state.notebooks = [nb("safe", '<script>alert("x")</script>', 1)];
    const html = render();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('aria-label="Delete &lt;script&gt;');
  });
  it("hides a presence shortcut whose notebook is no longer live", () => {
    state.ipad = { notebookId: "deleted" } as PresenceEntity;
    expect(render()).not.toContain("Open and follow");
  });
  it("links an iPad presence to its live notebook", () => {
    state.ipad = { notebookId: "a" } as PresenceEntity;
    const html = render();
    expect(html).toContain("Open and follow");
    expect(html).toContain("Currently on <strong>Algebra</strong>");
  });
});
