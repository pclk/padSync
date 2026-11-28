import type { Box } from "@/ink/geometry";
import { PAGE_WIDTH } from "@/lib/types";
import { MAX_BUNDLE_BYTES, pickSections, type ContextOptions, type Raster, type SectionInput, type SelectionInput } from "./context";
import { sectionPng, type RenderOmit } from "./export";
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
      // hlc strings sort as clocks and every write gets a fresh one, so the latest child stamp plus
      // the counts identifies the section's state; the wall-clock ms alone can collide.
      let latest = "";
      for (const x of [...strokes, ...texts]) if (x.hlc > latest) latest = x.hlc;
      const lastActivity = Math.max(hlcTime(s.hlc), hlcTime(latest));
      const notes = texts.filter((t) => !t.deleted).sort((a, b) => a.data.y - b.data.y).map((t) => t.data.text);
      return { id: s.id, data: s.data, notes, lastActivity, revision: `${s.hlc}|${latest}|${strokes.length}|${texts.length}` };
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
    // The render honours the toggles too: excluded notes or images must not leak through pixels.
    const slice = o.view?.slices.find((v) => v.sectionId === input.id);
    const omit = { notes: !o.notes, images: !o.images };
    const render = await (slice
      ? cropSection(sec, el, { minX: o.view!.x0, maxX: o.view!.x1, minY: slice.y0, maxY: slice.y1 }, 2, omit, 0)
      : sectionPng(sec, el, scale, omit).then(toRaster)
    ).catch(() => null);
    used += render?.base64.length ?? 0;
    out.push({ ...input, render, renderNote: render ? undefined : "could not render" });
  }
  return out;
}

/** The render cropped to the lasso box (plus a margin), so a selection shows its context. */
export function cropSelection(section: SectionEntity, el: HTMLElement, box: Box, scale = 2, omit: RenderOmit = {}): Promise<Raster> {
  return cropSection(section, el, box, scale, omit, 24);
}

/** The render cropped to `box` (page units) plus `pad`. */
async function cropSection(section: SectionEntity, el: HTMLElement, box: Box, scale: number, omit: RenderOmit, pad: number): Promise<Raster> {
  return toRaster(await cropPng(section, el, box, scale, omit, pad));
}

/** The section's picture (page, text and ink) inside `box` (page units) plus `pad`, as a PNG. */
export async function cropPng(section: SectionEntity, el: HTMLElement, box: Box, scale = 2, omit: RenderOmit = {}, pad = 0): Promise<Blob> {
  const full = await createImageBitmap(await sectionPng(section, el, scale, omit));
  // A tall section comes back smaller than asked (the renderer caps a side at 16,384 px), so map
  // page units by the bitmap's actual scale, not the requested one.
  scale = full.width / PAGE_WIDTH;
  const x0 = Math.max(0, Math.floor((box.minX - pad) * scale));
  const y0 = Math.max(0, Math.floor((box.minY - pad) * scale));
  const x1 = Math.min(full.width, Math.ceil((box.maxX + pad) * scale));
  const y1 = Math.min(full.height, Math.ceil((box.maxY + pad) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, x1 - x0);
  canvas.height = Math.max(1, y1 - y0);
  canvas.getContext("2d")!.drawImage(full, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  full.close();
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}
