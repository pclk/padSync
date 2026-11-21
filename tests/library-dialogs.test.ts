import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookEntity } from "@/lib/types";

vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/db", () => ({ db: {}, deviceId: () => "test" }));
vi.mock("@/lib/store", () => ({ createNotebook: vi.fn(), lastEditedTimes: vi.fn(), listNotebooks: vi.fn(), listFolders: vi.fn(), createFolder: vi.fn(), deleteFolders: vi.fn(), restoreFolders: vi.fn(), moveItems: vi.fn(), setDeleted: vi.fn(), putEntities: vi.fn() }));
vi.mock("@/components/SyncBadge", () => ({ SyncBadge: () => null }));
import { dialogKey } from "@/components/Dialog";
import { DeleteDialog, RenameDialog, UNDO_MS, UndoToast } from "@/components/Library";
import { deferredAction } from "@/lib/deferred";

const nb = { id: "a", data: { title: "Algebra <1>", createdAt: 1 } } as NotebookEntity;
const noop = () => {};

describe("deferred delete with undo", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("commits only after the undo window", async () => {
    const commit = vi.fn();
    const d = deferredAction(commit, UNDO_MS);
    await d.schedule("a");
    expect(d.pending()).toBe("a");
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledWith("a");
    expect(d.pending()).toBeUndefined();
  });

  it("undo cancels the pending delete so nothing is ever written", async () => {
    const commit = vi.fn();
    const d = deferredAction(commit, UNDO_MS);
    await d.schedule("a");
    expect(d.undo()).toBe("a");
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(d.undo()).toBeUndefined();
  });

  it("a second delete commits the first one, and flush commits immediately", async () => {
    const commit = vi.fn();
    const d = deferredAction(commit, UNDO_MS);
    await d.schedule("a");
    await d.schedule("b");
    expect(commit.mock.calls).toEqual([["a"]]);
    await d.flush();
    expect(commit.mock.calls).toEqual([["a"], ["b"]]);
    vi.advanceTimersByTime(UNDO_MS);
    expect(commit).toHaveBeenCalledTimes(2);
    await d.flush();
    expect(commit).toHaveBeenCalledTimes(2);
  });
});

describe("dialog keyboard handling", () => {
  const items = ["input", "cancel", "ok"];
  it("Escape closes", () => {
    expect(dialogKey("Escape", false, items, "input")).toEqual({ close: true });
  });
  it("Tab and Shift+Tab wrap around the ends and leave the middle alone", () => {
    expect(dialogKey("Tab", false, items, "ok")).toEqual({ focus: "input" });
    expect(dialogKey("Tab", true, items, "input")).toEqual({ focus: "ok" });
    expect(dialogKey("Tab", false, items, "input")).toBeNull();
    expect(dialogKey("Tab", true, items, "ok")).toBeNull();
  });
  it("pulls focus back in when it is outside the dialog", () => {
    expect(dialogKey("Tab", false, items, "elsewhere")).toEqual({ focus: "input" });
    expect(dialogKey("Tab", true, items, null)).toEqual({ focus: "ok" });
  });
  it("ignores other keys, so Enter submits the form natively", () => {
    expect(dialogKey("Enter", false, items, "input")).toBeNull();
    expect(dialogKey("a", false, items, "input")).toBeNull();
  });
});

describe("rename and delete dialogs", () => {
  it("rename is a labelled modal form with the current title and a submit button", () => {
    const html = renderToStaticMarkup(createElement(RenameDialog, { notebook: nb, onCancel: noop, onRename: noop }));
    expect(html).toMatch(/<form[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="([^"]+)"/);
    const id = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('class="card');
    expect(html).toMatch(/<input data-autofocus="true" class="field" value="Algebra &lt;1&gt;"/);
    expect(html).toMatch(/<button type="submit" class="btn btn-primary">Rename<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn btn-secondary">Cancel<\/button>/);
  });

  it("delete names the notebook, escapes it, and focuses the confirm button so Enter deletes", () => {
    const html = renderToStaticMarkup(createElement(DeleteDialog, { items: [nb], onCancel: noop, onDelete: noop }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Delete “Algebra &lt;1&gt;”?");
    expect(html).toMatch(/<button type="submit" data-autofocus="true"[^>]*>.*Delete<\/button>/);
  });

  it("the undo toast is a live status with an Undo button", () => {
    const html = renderToStaticMarkup(createElement(UndoToast, { message: "Deleted “Algebra <1>”", onUndo: noop }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Deleted “Algebra &lt;1&gt;”");
    expect(html).toMatch(/<button type="button"[^>]*>Undo<\/button>/);
  });

  it("the library no longer uses blocking browser prompts", () => {
    const src = readFileSync("src/components/Library.tsx", "utf8");
    expect(src).not.toMatch(/\b(prompt|confirm)\(/);
  });
});
