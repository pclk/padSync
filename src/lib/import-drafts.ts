import Dexie, { type Table } from "dexie";
import { nanoid } from "nanoid";
import { classify, type AttachmentMeta } from "./attachments";

// The AI import page's working state, kept on this device so leaving the page, switching tabs or
// reloading loses nothing: attached files (as blobs) and the JSON under review. Separate from the
// synced "padsync" database: drafts never sync and can be cleared without touching notebooks.

export interface StoredAttachment extends AttachmentMeta {
  order: number;
  blob: Blob;
  addedAt: number;
}

interface Kv {
  key: string;
  value: unknown;
}

class DraftDB extends Dexie {
  attachments!: Table<StoredAttachment, string>;
  kv!: Table<Kv, string>;
  constructor() {
    super("padsync-drafts");
    this.version(1).stores({ attachments: "id, order", kv: "key" });
  }
}

export const drafts = new DraftDB();

export async function listAttachments(): Promise<StoredAttachment[]> {
  return drafts.attachments.orderBy("order").toArray();
}

/** Longest side, and the size above which images are re-encoded smaller. */
const MAX_IMAGE_SIDE = 2400;
const SHRINK_ABOVE = 2_500_000;

async function toJpeg(blob: Blob, force: boolean): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    if (!force && scale === 1 && blob.size <= SHRINK_ABOVE) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // transparent PNGs would turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("could not encode"))), "image/jpeg", 0.88));
  } finally {
    bmp.close();
  }
}

/** Adds files at the end of the list. Returns one message per file that couldn't be added. */
export async function addFiles(files: File[]): Promise<string[]> {
  const errors: string[] = [];
  const last = await drafts.attachments.orderBy("order").last();
  let order = (last?.order ?? 0) + 1;
  for (const f of files) {
    const c = classify(f.name, f.type);
    if ("error" in c) {
      errors.push(c.error);
      continue;
    }
    let blob: Blob = f;
    let mime = c.mime;
    let name = f.name;
    // Large photos and formats the agents can't read become JPEGs; GIFs stay (animation).
    if (c.kind === "image" && (c.convert || (mime !== "image/gif" && f.size > SHRINK_ABOVE))) {
      try {
        const out = await toJpeg(f, c.convert);
        if (out !== f) {
          blob = out;
          mime = "image/jpeg";
          name = name.replace(/\.[A-Za-z0-9]{1,10}$/, "") + ".jpg";
        }
      } catch {
        if (c.convert) {
          errors.push(`${f.name}: this browser can't convert it; export it as JPEG or PNG first.`);
          continue;
        }
      }
    }
    if (!blob.size) {
      errors.push(`${f.name}: the file is empty.`);
      continue;
    }
    await drafts.attachments.add({ id: nanoid(), name, mime, kind: c.kind, size: blob.size, blob, order: order++, addedAt: Date.now() });
  }
  return errors;
}

export async function removeAttachment(id: string) {
  await drafts.attachments.delete(id);
}

export async function clearAttachments() {
  await drafts.attachments.clear();
}

/** Stores the list's new order (ids in display order). */
export async function reorderAttachments(ids: string[]) {
  await drafts.transaction("rw", drafts.attachments, async () => {
    for (const [i, id] of ids.entries()) await drafts.attachments.update(id, { order: i + 1 });
  });
}

export async function getDraft<T>(key: string): Promise<T | undefined> {
  return (await drafts.kv.get(key))?.value as T | undefined;
}

export async function setDraft(key: string, value: unknown) {
  if (value === undefined || value === null || value === "") await drafts.kv.delete(key);
  else await drafts.kv.put({ key, value });
}
