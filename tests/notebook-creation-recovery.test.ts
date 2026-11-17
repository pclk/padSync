import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createNotebook, listNotebooks, liveSections } from "@/lib/store";

vi.mock("@/lib/sync", () => ({ requestSync: vi.fn() }));
beforeEach(async () => { await db.entities.clear(); await db.events.clear(); });
afterEach(() => vi.restoreAllMocks());

it("rolls back notebook and sections when event storage fails, then safely retries", async () => {
  vi.spyOn(db.events, "add").mockRejectedValueOnce(new Error("disk full"));
  await expect(createNotebook("Retry me")).rejects.toThrow("disk full");
  expect(await db.entities.count()).toBe(0);
  expect(await db.events.count()).toBe(0);
  const id = await createNotebook("Retry me");
  expect((await listNotebooks()).map(n => n.id)).toEqual([id]);
  expect(await liveSections(id)).toHaveLength(1);
  expect(await db.events.count()).toBe(1);
});

it("does not record creation or leave partial rows when content persistence fails", async () => {
  vi.spyOn(db.entities, "bulkPut").mockRejectedValueOnce(new Error("write failed"));
  await expect(createNotebook("Missing")).rejects.toThrow("write failed");
  expect(await db.entities.count()).toBe(0);
  expect(await db.events.count()).toBe(0);
});

it("commits all requested sections with a single creation event", async () => {
  const id = await createNotebook("Lecture", [
    { blocks: [], template: "dots", minHeight: 800 },
    { blocks: [], template: "lines", minHeight: 900 },
  ]);
  const sections = await liveSections(id);
  expect(sections.map(s => s.data.order)).toEqual([1, 2]);
  expect(sections.every(s => s.dirty === 1 && s.hlc && s.notebookId === id)).toBe(true);
  expect((await db.events.toArray())[0]).toMatchObject({ notebookId: id, type: "notebook_create", data: { sections: 2 }, synced: 0 });
});

it("creates all PDF pages with shared document references and normal sync clocks", async () => {
  const { pdfSections } = await import('@/lib/pdf-meta');
  const sections = pdfSections('pdf-document','Examples.pdf',Array.from({length:149},(_,i) => ({width:595,height:842,text:`Question ${i+1}`})));
  const id = await createNotebook('Examples',sections,undefined,undefined,'pdf-notebook');
  expect(id).toBe('pdf-notebook');
  const saved = await liveSections(id);
  expect(saved).toHaveLength(149);
  expect(saved.map(s => s.data.pdf?.page)).toEqual(Array.from({length:149},(_,i) => i+1));
  expect(saved.every(s => s.dirty === 1 && !!s.hlc && s.data.pdf?.documentId === 'pdf-document')).toBe(true);
});
