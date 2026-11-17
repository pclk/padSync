import { nanoid } from "nanoid";
import { db, deviceId } from "./db";
import { hlcNow, hlcObserve } from "./hlc";
import { applyPatch, type SectionChange } from "./roundtrip";
import { requestSync } from "./sync";
import {
  SCREEN_HEIGHT,
  STROKE_STRIDE,
  type Entity,
  type EntityKind,
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
  await db.entities.bulkPut(stamped);
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

export async function createNotebook(title: string, sections: Omit<SectionData, "order" | "createdAt">[] = [], description?: string, source?: NotebookData["source"]) {
  const now = Date.now();
  const nb = newEntity<"notebook", NotebookData>("notebook", "", "", { title, description, createdAt: now, ...(source ? { source } : {}) });
  nb.notebookId = nb.id;
  const secs = (sections.length ? sections : [blankSection()]).map((s, i) =>
    newEntity<"section", SectionData>("section", nb.id, "", { ...s, order: i + 1, createdAt: now }),
  );
  await putEntities([nb, ...secs]);
  await logEvent(nb.id, null, "notebook_create", { sections: secs.length });
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
  const sorted = await liveSections(notebookId);
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
