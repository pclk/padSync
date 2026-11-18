import { PAGE_WIDTH, type SectionData } from './types';
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const PDF_PART_BYTES = 8 * 1024 * 1024;
export interface PdfPage { documentId: string; name: string; page: number; height: number; text: string }
export function pdfSections(documentId: string, name: string, pages: { width: number; height: number; text: string }[]): Omit<SectionData, 'order' | 'createdAt'>[] {
  if (!pages.length || pages.length > 2000 || pages.some(p => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0 || p.height / p.width > 8)) throw new Error('Unsupported PDF page dimensions or count');
  return pages.map((p, i) => { const height = Math.ceil(PAGE_WIDTH * p.height / p.width); return { title: `${name} — page ${i + 1}`, blocks: [], template: 'plain', minHeight: height, pdf: { documentId, name, page: i + 1, height, text: p.text } }; });
}
export const pdfSignature = (bytes: Uint8Array) => bytes.length >= 5 && [37,80,68,70,45].every((b,i) => bytes[i] === b);
