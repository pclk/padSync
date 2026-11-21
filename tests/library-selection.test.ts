import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { boxFrom, boxesOverlap, movable, parentFolder, rangeIds } from "@/lib/library";
import { createFolder, createNotebook, deleteFolders, listFolders, listNotebooks, moveItems, restoreFolders } from "@/lib/store";
import type { FolderEntity, NotebookEntity } from "@/lib/types";

vi.mock("@/lib/sync", () => ({ requestSync: vi.fn() }));

const folder = (id: string, folderId?: string) => ({ id, kind: "folder", data: { name: id, createdAt: 1, ...(folderId ? { folderId } : {}) } }) as FolderEntity;
const nb = (id: string, folderId?: string) => ({ id, kind: "notebook", data: { title: id, createdAt: 1, ...(folderId ? { folderId } : {}) } }) as NotebookEntity;
// a ─ b ─ c, and d at the top level
const map = new Map([folder("a"), folder("b", "a"), folder("c", "b"), folder("d")].map((f) => [f.id, f]));

describe("range and rectangle selection", () => {
  const order = ["f1", "f2", "n1", "n2", "n3"];
  it("selects from the anchor to the clicked item either way round", () => {
    expect(rangeIds(order, "f2", "n2")).toEqual(["f2", "n1", "n2"]);
    expect(rangeIds(order, "n3", "f2")).toEqual(["f2", "n1", "n2", "n3"]);
    expect(rangeIds(order, null, "n1")).toEqual(["n1"]);
    expect(rangeIds(order, "gone", "n1")).toEqual(["n1"]);
  });
  it("a dragged box hits the cards it overlaps, whichever corner it starts from", () => {
    const box = boxFrom(100, 100, 10, 10);
    expect(box).toEqual({ left: 10, top: 10, right: 100, bottom: 100 });
    expect(boxesOverlap(box, { left: 90, top: 90, right: 200, bottom: 200 })).toBe(true);
    expect(boxesOverlap(box, { left: 100, top: 0, right: 200, bottom: 50 })).toBe(false);
  });
});

describe("what can move where", () => {
  it("skips items already there and folders going into themselves", () => {
    expect(movable([nb("n", "b")], "b", map)).toEqual([]);
    expect(movable([folder("a")], "c", map)).toEqual([]);
    expect(movable([folder("b", "a")], "b", map)).toEqual([]);
    expect(movable([folder("c", "b")], "d", map).map((i) => i.id)).toEqual(["c"]);
  });
  it("leaves items whose folder moves too inside it", () => {
    const sel = [folder("b", "a"), nb("n", "b"), nb("m", "c"), nb("top")];
    expect(movable(sel, "d", map).map((i) => i.id)).toEqual(["b", "top"]);
  });
  it("finds the parent one level up", () => {
    expect(parentFolder(nb("n", "c"), map)).toBe("b");
    expect(parentFolder(nb("n", "a"), map)).toBe("");
    expect(parentFolder(nb("n"), map)).toBeNull();
    expect(parentFolder(nb("n", "missing"), map)).toBeNull();
  });
});

describe("bulk moves and folder deletes", () => {
  beforeEach(async () => { await db.entities.clear(); await db.events.clear(); });
  const folderOfRow = async (id: string) => ((await db.entities.get(id)) as NotebookEntity | FolderEntity).data.folderId ?? "";

  it("moves each item to its own destination in one go", async () => {
    const a = await createFolder("A");
    const b = await createFolder("B", a);
    const n1 = await createNotebook("one", [], undefined, undefined, undefined, b);
    const n2 = await createNotebook("two", [], undefined, undefined, undefined, a);
    await moveItems([{ id: n1, to: a }, { id: n2, to: "" }]);
    expect(await folderOfRow(n1)).toBe(a);
    expect(await folderOfRow(n2)).toBe("");
  });

  it("deleting nested folders moves survivors to the nearest folder that stays, and undo puts everything back", async () => {
    const a = await createFolder("A");
    const b = await createFolder("B", a);
    const c = await createFolder("C", b);
    const kept = await createNotebook("kept", [], undefined, undefined, undefined, c);
    const doomed = await createNotebook("doomed", [], undefined, undefined, undefined, c);
    const rows = (await listFolders()).filter((f) => f.id === b || f.id === c);
    const undo = await deleteFolders(rows, [doomed]);
    expect((await listFolders()).map((f) => f.id)).toEqual([a]);
    expect(await folderOfRow(kept)).toBe(a);
    // A notebook deleted alongside stays where it was, so undoing its delete restores it in place.
    expect(await folderOfRow(doomed)).toBe(c);
    await restoreFolders(undo);
    expect((await listFolders()).map((f) => f.id).sort()).toEqual([a, b, c].sort());
    expect(await folderOfRow(kept)).toBe(c);
    expect((await listNotebooks()).length).toBe(2);
  });
});
