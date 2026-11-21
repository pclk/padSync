import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { folderOf, folderPath, isWithin, sortFolders } from "@/lib/library";
import { createFolder, createNotebook, deleteFolder, listFolders, listNotebooks, moveToFolder } from "@/lib/store";
import type { FolderEntity, NotebookEntity } from "@/lib/types";

const live = vi.hoisted(() => ({ values: [] as unknown[], call: 0 }));
vi.mock("@/lib/sync", () => ({ requestSync: vi.fn() }));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => live.values[live.call++ % 5] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));
import Library, { MoveDialog } from "@/components/Library";

const folder = (id: string, name: string, folderId?: string) => ({ id, kind: "folder", data: { name, createdAt: 1, ...(folderId ? { folderId } : {}) } }) as FolderEntity;
const nb = (id: string, title: string, folderId?: string) => ({ id, kind: "notebook", data: { title, createdAt: 1, ...(folderId ? { folderId } : {}) } }) as NotebookEntity;

beforeEach(async () => {
  await db.entities.clear();
  await db.events.clear();
  live.call = 0;
  sessionStorage.clear();
});

describe("folder helpers", () => {
  const map = new Map([folder("a", "Year 1"), folder("b", "Physics", "a"), folder("c", "Waves", "b")].map((f) => [f.id, f]));
  it("walks the path from the top level and finds descendants", () => {
    expect(folderPath("c", map).map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(folderPath("", map)).toEqual([]);
    expect(isWithin("c", "a", map)).toBe(true);
    expect(isWithin("a", "c", map)).toBe(false);
  });
  it("treats a missing folder as the top level and survives a cycle", () => {
    expect(folderOf(nb("n", "x", "gone"), map)).toBe("");
    const loop = new Map([folder("x", "X", "y"), folder("y", "Y", "x")].map((f) => [f.id, f]));
    expect(folderPath("x", loop).length).toBe(2);
  });
  it("sorts folder names naturally", () => {
    expect(sortFolders([folder("1", "Week 10"), folder("2", "Week 2")]).map((f) => f.data.name)).toEqual(["Week 2", "Week 10"]);
  });
});

describe("folder store", () => {
  it("creates notebooks and folders inside folders and moves them", async () => {
    const parent = await createFolder("Year 1");
    const child = await createFolder("Physics", parent);
    const id = await createNotebook("Mechanics", [], undefined, undefined, undefined, child);
    expect(((await db.entities.get(id)) as NotebookEntity).data.folderId).toBe(child);
    await moveToFolder([(await db.entities.get(id)) as NotebookEntity], "");
    expect(((await db.entities.get(id)) as NotebookEntity).data).not.toHaveProperty("folderId");
  });
  it("deleting a folder moves its contents up a level and keeps them", async () => {
    const parent = await createFolder("Year 1");
    const child = await createFolder("Physics", parent);
    const inner = await createFolder("Waves", child);
    const id = await createNotebook("Mechanics", [], undefined, undefined, undefined, child);
    await deleteFolder((await db.entities.get(child)) as FolderEntity);
    expect((await listFolders()).map((f) => f.id).sort()).toEqual([parent, inner].sort());
    expect(((await db.entities.get(inner)) as FolderEntity).data.folderId).toBe(parent);
    expect((await listNotebooks()).find((n) => n.id === id)?.data.folderId).toBe(parent);
  });
});

describe("library folders view", () => {
  const folders = [folder("a", "Year 1"), folder("b", "Physics", "a")];
  const notebooks = [nb("n1", "Top notebook"), nb("n2", "Mechanics", "b")];
  const render = () => { live.call = 0; return renderToStaticMarkup(createElement(Library)); };
  it("shows only top-level folders and notebooks at the top level", () => {
    live.values = [notebooks, new Map(), undefined, new Map(), folders];
    const html = render();
    expect(html).toContain("Year 1");
    expect(html).not.toContain("Physics");
    expect(html).toContain("Top notebook");
    expect(html).not.toContain("Mechanics");
  });
  it("opens the remembered folder with a breadcrumb", () => {
    sessionStorage.setItem("padsync.library.folder", "b");
    live.values = [notebooks, new Map(), undefined, new Map(), folders];
    const html = render();
    expect(html).toContain("Mechanics");
    expect(html).not.toContain("Top notebook");
    expect(html).toContain("All notebooks");
    expect(html).toContain("Back to Year 1");
  });
  it("move dialog leaves out the folder itself and folders inside it", () => {
    const html = renderToStaticMarkup(createElement(MoveDialog, { items: [folders[0]], folders, onCancel: () => {}, onMove: () => {} }));
    expect(html).toContain("All notebooks (top level)");
    expect(html).not.toContain("Physics");
  });
});
