import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { applyImport, type ImportApplication } from "@/lib/import-application";
import { createNotebook, liveSections } from "@/lib/store";

const raw = JSON.stringify({ schemaVersion: 2, title: "Lecture", sections: [
  { title: "First", blocks: [{ type: "markdown", text: "Preserved" }, { type: "space", size: "s" }] },
  { title: "Second", blocks: [{ type: "code", code: "x = 1", language: "python" }] },
] });
const input = (patch: Partial<ImportApplication> = {}): ImportApplication => ({ raw, selected: new Set([0, 1]), destination: { kind: "new" }, accepted: true, ...patch });
beforeEach(async () => { await db.entities.clear(); await db.events.clear(); await db.meta.clear(); });

it("appends selected sections without rewriting existing content and retains lecture sources", async () => {
  const id = await createNotebook("Existing");
  const before = await liveSections(id);
  const sources = [{ attachmentId: "lecture-1", pages: [2, 3] }];
  const result = await applyImport(input({ destination: { kind: "append", notebookId: id }, selected: new Set([1]), sources }));
  expect(result?.notebookId).toBe(id);
  const sections = await liveSections(id);
  expect(sections[0]).toEqual(before[0]);
  expect(sections[1].data).toMatchObject({ title: "Second", sources, blocks: [{ type: "code", code: "x = 1" }] });
  expect(sections[1].data.order).toBeGreaterThan(before[0].data.order);
});

it("serializes concurrent accepts and persists the receipt across a database reopen and changed selection", async () => {
  const results = await Promise.all([applyImport(input()), applyImport(input())]);
  expect(results.filter((r) => r?.duplicate)).toHaveLength(1);
  expect(results[0]?.notebookId).toBe(results[1]?.notebookId);
  db.close();
  await db.open();
  const retry = await applyImport(input({ selected: new Set([1]) }));
  expect(retry?.duplicate).toBe(true);
  expect(await db.entities.where("kind").equals("section").count()).toBe(2);
  expect((await db.events.toArray()).filter((e) => e.type === "ai_import_apply").length).toBe(1);
});

it("cancelled preview and invalid output write nothing", async () => {
  expect(await applyImport(input({ accepted: false }))).toBeNull();
  await expect(applyImport(input({ raw: "not JSON" }))).rejects.toThrow();
  await expect(applyImport(input({ selected: new Set() }))).rejects.toThrow();
  expect(await db.entities.count()).toBe(0);
  expect(await db.meta.count()).toBe(0);
  expect(await db.events.count()).toBe(0);
});

it("failed destinations leave no receipt so acceptance can be retried", async () => {
  await expect(applyImport(input({ destination: { kind: "append", notebookId: "missing" } }))).rejects.toThrow();
  expect(await db.meta.count()).toBe(0);
  expect((await applyImport(input()))?.duplicate).toBe(false);
});

it("converts legacy output and preserves mixed blocks", async () => {
  const legacy = JSON.stringify({ title: "Old", sections: [{ title: "Mixed", blocks: [{ type: "markdown", text: "Hello" }, { type: "divider" }, { type: "code", code: "a", language: "text" }] }] });
  const result = await applyImport(input({ raw: legacy, selected: new Set([0]) }));
  const sections = await liveSections(result!.notebookId);
  expect(sections[0].data.blocks.map((b) => b.type)).toEqual(["markdown", "divider", "code"]);
});


it("rolls back all content when receipt persistence fails", async () => {
  const write = vi.spyOn(db.meta, "add").mockRejectedValueOnce(new Error("storage failure"));
  await expect(applyImport(input())).rejects.toThrow("storage failure");
  write.mockRestore();
  expect(await db.entities.count()).toBe(0);
  expect(await db.events.count()).toBe(0);
  expect(await db.meta.count()).toBe(0);
  expect((await applyImport(input()))?.duplicate).toBe(false);
});

it('recognizes an appended result from synced sections when local receipts are absent', async () => {
  const notebookId = await createNotebook('Synced target');
  const first = await applyImport(input({destination:{kind:'append',notebookId}}));
  await db.meta.clear();
  const again = await applyImport(input({destination:{kind:'append',notebookId}}));
  expect(again?.duplicate).toBe(true);
  expect(again?.notebookId).toBe(first?.notebookId);
  expect(await liveSections(notebookId)).toHaveLength(3);
});
