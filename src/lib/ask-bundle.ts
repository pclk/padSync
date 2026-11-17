import type { Box } from "@/ink/geometry";
import { MAX_BUNDLE_BYTES, pickSections, type ContextOptions, type Raster, type SectionInput, type SelectionInput } from "./context";
import { sectionPng } from "./export";
import { db } from "./db";
import type { SectionEntity, StrokeEntity, TextBoxEntity } from "./types";

// Browser half of the context bundle: reads notes, activity and renders from the local database
// and the DOM, then hands plain data to buildBundle (src/lib/context.ts).

export const hlcTime = (hlc: string) => Number(hlc.slice(0, 13)) || 0;

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function toRaster(blob: Blob): Promise<Raster> {
  const bmp = await createImageBitmap(blob);
  const r = { base64: await blobToBase64(blob), width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

/** Text-only inputs (no renders): cheap, used for the summary before anything is rendered. */
export async function gatherSections(sections: SectionEntity[]): Promise<SectionInput[]> {
  return Promise.all(
    sections.map(async (s) => {
      // Deleted children too: erasing ink is activity, and must invalidate a previewed render.
      const [strokes, texts] = await Promise.all([
        db.entities.where("[parentId+kind]").equals([s.id, "stroke"]).toArray() as Promise<StrokeEntity[]>,
        db.entities.where("[parentId+kind]").equals([s.id, "textbox"]).toArray() as Promise<TextBoxEntity[]>,
      ]);
      let lastActivity = hlcTime(s.hlc);
      for (const x of [...strokes, ...texts]) lastActivity = Math.max(lastActivity, hlcTime(x.hlc));
      const notes = texts.filter((t) => !t.deleted).sort((a, b) => a.data.y - b.data.y).map((t) => t.data.text);
      return { id: s.id, data: s.data, notes, lastActivity };
    }),
  );
}

/** Adds renders for the sections the options pick (scale 2 for a single section, else 1). */
export async function addRenders(inputs: SectionInput[], sections: SectionEntity[], o: ContextOptions, sectionEl: (id: string) => HTMLElement | undefined, selection?: SelectionInput | null) {
  if (!o.renders || o.scope === "selection") return inputs;
  const picked = new Set(pickSections(inputs, o, selection).map((s) => s.id));
  const scale = picked.size === 1 ? 2 : 1;
  const out: SectionInput[] = [];
  let used = 0;
  for (const input of inputs) {
    const el = sectionEl(input.id);
    const sec = sections.find((s) => s.id === input.id);
    if (!picked.has(input.id) || !el || !sec) {
      out.push(input);
      continue;
    }
    // Once the budget is spent, later renders would be dropped anyway: don't make them.
    if (used >= MAX_BUNDLE_BYTES) {
      out.push({ ...input, renderNote: "size limit" });
      continue;
    }
    // One at a time: rendering every section at once can exhaust memory on the iPad.
    const render = await sectionPng(sec, el, scale).then(toRaster, () => null);
    used += render?.base64.length ?? 0;
    out.push({ ...input, render, renderNote: render ? undefined : "could not render" });
  }
  return out;
}

/** The render cropped to the lasso box (plus a margin), so a selection shows its context. */
export async function cropSelection(section: SectionEntity, el: HTMLElement, box: Box, scale = 2): Promise<Raster> {
  const full = await createImageBitmap(await sectionPng(section, el, scale));
  const pad = 24;
  const x0 = Math.max(0, Math.floor((box.minX - pad) * scale));
  const y0 = Math.max(0, Math.floor((box.minY - pad) * scale));
  const x1 = Math.min(full.width, Math.ceil((box.maxX + pad) * scale));
  const y1 = Math.min(full.height, Math.ceil((box.maxY + pad) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, x1 - x0);
  canvas.height = Math.max(1, y1 - y0);
  canvas.getContext("2d")!.drawImage(full, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  full.close();
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
  return toRaster(blob);
}
