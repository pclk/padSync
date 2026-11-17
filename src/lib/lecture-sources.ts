import type { AttachmentMeta } from './attachments';
import type { LectureSource } from './types';

/** Snapshot provenance when sending: later attachment edits must not relabel a result. */
export function lectureSources(files: Pick<AttachmentMeta, 'persistentId' | 'name' | 'sourceFilename' | 'selectedPages'>[]): LectureSource[] {
  return files.flatMap(f => f.persistentId ? [{ attachmentId: f.persistentId, name: f.sourceFilename ?? f.name, ...(f.selectedPages ? { pages: [...f.selectedPages] } : {}) }] : []);
}
