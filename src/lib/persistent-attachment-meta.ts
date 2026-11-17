import type { AttachmentMeta } from './attachments';
export const PDF_CHUNK_BYTES = 1_800_000;
export interface PersistentPdf extends AttachmentMeta { notebookId: string; persistentId: string }
export function parseSelectedPages(value: string): number[] | undefined {
  if (!value.trim()) return undefined;
  const pages = new Set<number>();
  for (const token of value.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(token);
    if (!match) throw new Error('Use page numbers or ranges, such as 1, 3-5.');
    const start = Number(match[1]), end = Number(match[2] ?? start);
    if (start < 1 || end < start || end > 10000) throw new Error('Pages must be between 1 and 10000 in ascending ranges.');
    for (let n = start; n <= end; n++) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}
