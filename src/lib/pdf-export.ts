import { sectionPng } from "./export";
import type { SectionEntity } from "./types";

// CSS px to PDF points.
const PT = 0.75;

export interface PdfPage { jpeg: Uint8Array; w: number; h: number; cssW: number; cssH: number }

/** One JPEG per section, each on its own page sized to the section, as a minimal PDF. */
export async function notebookPdf(sections: SectionEntity[], sectionEl: (id: string) => HTMLElement | undefined, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  return buildPdf(await sectionPages(sections, sectionEl, onProgress));
}

export async function sectionPages(sections: SectionEntity[], sectionEl: (id: string) => HTMLElement | undefined, onProgress?: (done: number, total: number) => void): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  for (const [i, s] of sections.entries()) {
    const el = sectionEl(s.id);
    if (!el) continue;
    // One at a time: rendering every section at once can exhaust memory on the iPad.
    const bmp = await createImageBitmap(await sectionPng(s, el, 2));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const jpeg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.9));
    // The renderer caps a side at 16,384 px, so size the page from the section, not the bitmap.
    const cssW = el.offsetWidth || canvas.width / 2;
    pages.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), w: canvas.width, h: canvas.height, cssW, cssH: (cssW * canvas.height) / canvas.width });
    onProgress?.(i + 1, sections.length);
  }
  return pages;
}

export function buildPdf(pages: PdfPage[]): Blob {
  if (!pages.length) throw new Error("Nothing to export");

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    parts.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  // Objects: 1 catalog, 2 pages, then per page: page, content, image.
  const pageObj = (i: number) => 3 + i * 3;
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  pages.forEach((p, i) => {
    const n = pageObj(i);
    const w = (p.cssW * PT).toFixed(2), h = (p.cssH * PT).toFixed(2);
    obj(n, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n + 1, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    obj(n + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push("\nendstream");
    });
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
