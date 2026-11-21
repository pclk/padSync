import Dexie from "dexie";
import { nanoid } from "nanoid";
import { db, deviceId } from "./db";
import { hlcNow, hlcObserve, hlcWall } from "./hlc";
import type { SectionChange } from "./roundtrip";
import { requestSync } from "./sync";
import { debugNow, recordSyncDebug, syncDebugEnabled } from "./sync-debug";
import {
  SCREEN_HEIGHT,
  STROKE_STRIDE,
  type Entity,
  type EntityKind,
  type FolderData,
  type FolderEntity,
  type NotebookData,
  type NotebookEntity,
  type PadEvent,
  type SectionData,
  type SectionEntity,
  type StrokeEntity,
  type TextBoxData,
  type TextBoxEntity,
} from "./types";

// All local writes go through here: stamp a fresh clock, mark dirty, schedule a push.

export async function putEntities<E extends Entity>(entities: E[]): Promise<E[]> {
  if (!entities.length) return [];
  const device = deviceId();
  // A rewrite must sort after the version it replaces, even if this device's clock went back
  // since that version was stamped (the server ignores writes with an older hlc).
  for (const e of entities) if (e.hlc) hlcObserve(e.hlc);
  const stamped = entities.map((e) => ({ ...e, hlc: hlcNow(device), dirty: 1 as const }));
  const began = debugNow();
  await db.entities.bulkPut(stamped);
  if (syncDebugEnabled()) recordSyncDebug('local', 'Local entities saved (transaction may still be open)', {
    durationMs: debugNow() - began, count: stamped.length,
    versions: stamped.slice(0, 8).map(entity => `${entity.kind}:${entity.id}@${entity.hlc}`).join(', '),
  });
  requestSync();
  return stamped;
}

export function newEntity<K extends EntityKind, D>(kind: K, notebookId: string, parentId: string, data: D, id = nanoid()): Entity<K, D> {
  return { id, kind, notebookId, parentId, data, hlc: "", deleted: 0, dirty: 1 };
}

export async function setDeleted(ids: string[], deleted: boolean) {
  const rows = (await db.entities.bulkGet(ids)).filter((e): e is Entity => !!e);
  await putEntities(rows.map((e) => ({ ...e, deleted: deleted ? 1 : 0 })));
}

export async function updateData<D>(id: string, patch: (data: D) => D) {
  const row = await db.entities.get(id);
  if (!row) return;
  await putEntities([{ ...row, data: patch(row.data as D) }]);
}

export async function createNotebook(title: string, sections: Omit<SectionData, "order" | "createdAt">[] = [], description?: string, source?: NotebookData["source"], notebookId?: string, folderId?: string) {
  const now = Date.now();
  const nb = newEntity<"notebook", NotebookData>("notebook", "", "", { title, description, createdAt: now, ...(source ? { source } : {}), ...(folderId ? { folderId } : {}) });
  if (notebookId) nb.id = notebookId;
  nb.notebookId = nb.id;
  const secs = (sections.length ? sections : [blankSection()]).map((s, i) =>
    newEntity<"section", SectionData>("section", nb.id, "", { ...s, order: i + 1, createdAt: now }),
  );
  // A failed event write must not leave a notebook behind when the UI offers retry.
  await db.transaction("rw", db.entities, db.events, async () => {
    await putEntities([nb, ...secs]);
    await logEvent(nb.id, null, "notebook_create", { sections: secs.length });
  });
  return nb.id;
}

export function blankSection(): Omit<SectionData, "order" | "createdAt"> {
  return { blocks: [], template: "dots", minHeight: SCREEN_HEIGHT };
}

export async function insertSectionAfter(notebookId: string, after: SectionEntity | null, sorted: SectionEntity[]) {
  const idx = after ? sorted.findIndex((s) => s.id === after.id) : sorted.length - 1;
  const prev = sorted[idx]?.data.order ?? 0;
  const next = sorted[idx + 1]?.data.order ?? prev + 2;
  const sec = newEntity<"section", SectionData>("section", notebookId, "", {
    ...blankSection(),
    order: (prev + next) / 2,
    createdAt: Date.now(),
  });
  await putEntities([sec]);
  return sec.id;
}

export async function swapSectionOrder(a: SectionEntity, b: SectionEntity) {
  await putEntities([
    { ...a, data: { ...a.data, order: b.data.order } },
    { ...b, data: { ...b.data, order: a.data.order } },
  ]);
}

export async function addTextBox(notebookId: string, sectionId: string, x: number, y: number) {
  const tb = newEntity<"textbox", TextBoxData>("textbox", notebookId, sectionId, { x, y, w: 420, text: "", fontSize: 20, color: "#1f2937" });
  await putEntities([tb]);
  return tb.id;
}

export async function moveStrokes(strokes: StrokeEntity[], dx: number, dy: number) {
  await putEntities(
    strokes.map((s) => {
      const pts = s.data.pts.slice();
      for (let i = 0; i < pts.length; i += STROKE_STRIDE) {
        pts[i] += dx;
        pts[i + 1] += dy;
      }
      return { ...s, data: { ...s.data, pts } };
    }),
  );
}

export async function logEvent(notebookId: string, sectionId: string | null, type: string, data: Record<string, unknown> = {}) {
  const ev: PadEvent = { id: nanoid(), notebookId, sectionId, type, t: Date.now(), device: deviceId(), data, synced: 0 };
  await db.events.add(ev);
  requestSync();
}

/** Live notebooks made from this import before (same payload hash). */
export async function findImported(importHash: string) {
  return (await listNotebooks()).filter((n) => n.data.source?.importHash === importHash);
}

export async function listNotebooks() {
  return (await db.entities.where("kind").equals("notebook").toArray()).filter((n) => !n.deleted) as NotebookEntity[];
}

export async function listFolders() {
  return (await db.entities.where("kind").equals("folder").toArray()).filter((f) => !f.deleted) as FolderEntity[];
}

export async function createFolder(name: string, folderId?: string) {
  const f = newEntity<"folder", FolderData>("folder", "", "", { name, createdAt: Date.now(), ...(folderId ? { folderId } : {}) });
  f.notebookId = f.id;
  await putEntities([f]);
  return f.id;
}

/** Moves notebooks and folders into a folder ("" for the top level). */
export async function moveToFolder(items: (NotebookEntity | FolderEntity)[], folderId: string) {
  await moveItems(items.map((item) => ({ id: item.id, to: folderId })));
}

/**
 * Moves each item to its own destination folder ("" for the top level) in one write. Checked
 * against what is stored now, not what the screen showed: a move into a folder that is gone, or
 * of a folder into itself or a folder inside it, is skipped.
 */
export async function moveItems(moves: { id: string; to: string }[]) {
  await db.transaction("rw", db.entities, async () => {
    const rows = await db.entities.bulkGet(moves.map((m) => m.id));
    const parent = new Map(((await db.entities.where("kind").equals("folder").toArray()) as FolderEntity[])
      .filter((f) => !f.deleted).map((f) => [f.id, f.data.folderId ?? ""]));
    const within = (id: string, ancestor: string) => {
      for (const seen = new Set<string>(); id && !seen.has(id); id = parent.get(id) ?? "") {
        if (id === ancestor) return true;
        seen.add(id);
      }
      return false;
    };
    const out: (NotebookEntity | FolderEntity)[] = [];
    rows.forEach((e, i) => {
      const to = moves[i].to;
      if (!e || e.deleted || (e.kind !== "notebook" && e.kind !== "folder")) return;
      if (to && (!parent.has(to) || (e.kind === "folder" && within(to, e.id)))) return;
      const { folderId: _old, ...data } = e.data as NotebookData | FolderData;
      void _old;
      if (e.kind === "folder") parent.set(e.id, to);
      out.push({ ...e, data: to ? { ...data, folderId: to } : data } as NotebookEntity | FolderEntity);
    });
    await putEntities(out);
  });
}

/** What deleteFolders changed, so it can be undone. */
export interface FolderDeletion { folderIds: string[]; moved: { id: string; from: string }[] }

/**
 * Deletes folders; what was inside and isn't being deleted moves up to the nearest folder that
 * survives, so nothing is lost. `keep` names items deleted alongside (left where they are).
 */
export async function deleteFolders(folders: FolderEntity[], keep: string[] = []): Promise<FolderDeletion> {
  const gone = new Set(folders.map((f) => f.id));
  const skip = new Set(keep);
  return db.transaction("rw", db.entities, async () => {
    const all = (await db.entities.where("kind").anyOf("notebook", "folder").toArray()).filter((e) => !e.deleted) as (NotebookEntity | FolderEntity)[];
    const parent = new Map(all.filter((e) => e.kind === "folder").map((f) => [f.id, f.data.folderId ?? ""]));
    const survivor = (id: string) => {
      const seen = new Set<string>();
      while (id && gone.has(id) && !seen.has(id)) { seen.add(id); id = parent.get(id) ?? ""; }
      return gone.has(id) ? "" : id;
    };
    const moved = all
      .filter((e) => !gone.has(e.id) && !skip.has(e.id) && e.data.folderId && gone.has(e.data.folderId))
      .map((e) => ({ id: e.id, from: e.data.folderId!, to: survivor(e.data.folderId!) }));
    await moveItems(moved);
    const rows = all.filter((e) => gone.has(e.id));
    await putEntities(rows.map((e) => ({ ...e, deleted: 1 as const })));
    return { folderIds: rows.map((r) => r.id), moved: moved.map(({ id, from }) => ({ id, from })) };
  });
}

/** Brings deleted folders back and returns what was moved out of them. */
export async function restoreFolders(d: FolderDeletion) {
  await db.transaction("rw", db.entities, async () => {
    await setDeleted(d.folderIds, false);
    await moveItems(d.moved.map((m) => ({ id: m.id, to: m.from })));
  });
}

/** Deletes a folder; what was inside moves up to the folder's parent, so nothing is lost. */
export async function deleteFolder(folder: FolderEntity) {
  return deleteFolders([folder]);
}

/**
 * When each live notebook was last edited: the newest clock stamp among the notebook and every
 * section, stroke and text box in it (deletes and erases restamp the row, so they count too).
 * Remote rows keep the stamp of the device that wrote them, so a pull moves the time to when the
 * edit happened, not when it arrived. Presence is skipped: scrolling is not editing. Reads one or
 * two rows per notebook through [notebookId+hlc]; nothing extra is written per stroke.
 */
export async function lastEditedTimes(): Promise<Map<string, number>> {
  const notebooks = await listNotebooks();
  const times = new Map<string, number>();
  await Promise.all(notebooks.map(async (nb) => {
    const newest = await db.entities
      .where("[notebookId+hlc]")
      .between([nb.id, Dexie.minKey], [nb.id, Dexie.maxKey])
      .reverse()
      .filter((e) => e.kind !== "presence")
      .first();
    times.set(nb.id, (newest && hlcWall(newest.hlc)) ?? nb.data.createdAt);
  }));
  return times;
}

export function liveSections(notebookId: string) {
  return db.entities
    .where("[notebookId+kind]")
    .equals([notebookId, "section"])
    .toArray()
    .then((rows) => (rows.filter((r) => !r.deleted) as SectionEntity[]).sort((a, b) => a.data.order - b.data.order));
}

export function liveChildren<T extends Entity>(sectionId: string, kind: EntityKind) {
  return db.entities
    .where("[parentId+kind+deleted]")
    .equals([sectionId, kind, 0])
    .toArray()
    .then((rows) => rows as T[]);
}

export type { TextBoxEntity };

/** Applies reviewed AI changes: patches existing sections, appends new ones. Never deletes. */
export async function applyNotebookChanges(notebookId: string, changes: SectionChange[]) {
  // Loaded here, not at the top: roundtrip pulls in zod, which the notebook doesn't need to start.
  const [{ applyPatch }, sorted] = await Promise.all([import("./roundtrip"), liveSections(notebookId)]);
  const rows: Entity[] = [];
  for (const c of changes) {
    if (c.kind !== "update") continue;
    const row = sorted.find((s) => s.id === c.id);
    if (row) rows.push({ ...row, data: applyPatch(row.data, c.patch) });
  }
  let order = sorted.at(-1)?.data.order ?? 0;
  const now = Date.now();
  for (const c of changes) if (c.kind === "add") rows.push(newEntity<"section", SectionData>("section", notebookId, "", { ...c.data, order: ++order, createdAt: now }));
  await putEntities(rows);
  if (rows.length) await logEvent(notebookId, null, "ai_apply", { updated: changes.filter((c) => c.kind === "update").length, added: changes.filter((c) => c.kind === "add").length });
  return rows.length;
}


export interface ImportReceipt {
  notebookId: string;
  title: string;
  sectionIds: string[];
  appliedAt: number;
}

/** The receipt, content and event commit together, serialized across tabs by IndexedDB. */
export async function applyImportedSections(input: {
  receiptKey: string;
  destination: { kind: "new" } | { kind: "append"; notebookId: string };
  title: string;
  description?: string;
  sections: Omit<SectionData, "order" | "createdAt">[];
  importHash: string;
  legacyHashes: string[];
  jobId?: string;
}): Promise<ImportReceipt & { duplicate: boolean }> {
  const result = await db.transaction("rw", db.entities, db.meta, db.events, async () => {
    const key = `ai-import-receipt:${input.receiptKey}`;
    const prior = await db.meta.get(key);
    if (prior) return { ...(prior.value as ImportReceipt), duplicate: true };
    const synced = (await db.entities.where("kind").equals("section").toArray() as SectionEntity[]).find(s => s.data.importApplication?.key === input.receiptKey);
    if (synced) {
      const receipt: ImportReceipt = { notebookId: synced.notebookId, title: synced.data.importApplication!.title, sectionIds: [synced.id], appliedAt: synced.data.importApplication!.appliedAt };
      await db.meta.add({ key, value: receipt });
      return { ...receipt, duplicate: true };
    }
    // Honor notebooks imported before receipts existed, including soft-deleted ones.
    const legacy = (await db.entities.where("kind").equals("notebook").toArray() as NotebookEntity[])
      .find((n) => n.data.source && input.legacyHashes.includes(n.data.source.importHash));
    if (legacy) {
      const receipt: ImportReceipt = { notebookId: legacy.id, title: legacy.data.title, sectionIds: [], appliedAt: legacy.data.source!.importedAt };
      await db.meta.add({ key, value: receipt });
      return { ...receipt, duplicate: true };
    }
    if (!input.sections.length) throw new Error("No sections selected.");
    const now = Date.now();
    let notebook: NotebookEntity;
    const rows: Entity[] = [];
    let order = 0;
    if (input.destination.kind === "append") {
      const target = await db.entities.get(input.destination.notebookId);
      if (!target || target.kind !== "notebook" || target.deleted) throw new Error("The destination notebook is no longer available.");
      notebook = target as NotebookEntity;
      order = (await liveSections(notebook.id)).at(-1)?.data.order ?? 0;
    } else {
      notebook = newEntity("notebook", "", "", { title: input.title, description: input.description, createdAt: now,
        source: { importHash: input.importHash, importedAt: now, ...(input.jobId ? { jobId: input.jobId } : {}) } });
      notebook.id = `import-${input.receiptKey}`;
      notebook.notebookId = notebook.id;
      rows.push(notebook);
    }
    const sections = input.sections.map((s, index) => ({ ...newEntity("section", notebook.id, "", { ...s, importApplication: { key: input.receiptKey, title: notebook.data.title, appliedAt: now }, order: ++order, createdAt: now }), id: `import-${input.receiptKey}-${index}` }));
    rows.push(...sections);
    const device = deviceId();
    await db.entities.bulkPut(rows.map((e) => ({ ...e, hlc: hlcNow(device), dirty: 1 as const })));
    const receipt: ImportReceipt = { notebookId: notebook.id, title: notebook.data.title, sectionIds: sections.map((s) => s.id), appliedAt: now };
    await db.events.add({ id: nanoid(), notebookId: notebook.id, sectionId: null, type: "ai_import_apply", t: now, device, data: { sections: sections.length, destination: input.destination.kind }, synced: 0 });
    await db.meta.add({ key, value: receipt });
    return { ...receipt, duplicate: false };
  });
  requestSync();
  return result;
}
