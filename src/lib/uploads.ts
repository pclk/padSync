// Large job inputs (lecture files for AI import) don't fit one request: Vercel caps a body at
// 4.5 MB. They are declared up front in the job's `uploads` manifest, sent as base64 parts, and
// fetched part by part by the bridge, which reassembles them into ordinary job files.

/** Base64 chars per part (a multiple of 4, so every part decodes on its own). ~1.8 MB raw. */
export const PART_CHARS = 2_400_000;
export const MAX_UPLOAD_FILES = 20;
/** Raw bytes. */
export const MAX_FILE_BYTES = 25_000_000;
export const MAX_TOTAL_BYTES = 40_000_000;

export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const MAX_FILE_CHARS = base64Length(MAX_FILE_BYTES);
export const MAX_TOTAL_CHARS = base64Length(MAX_TOTAL_BYTES);

export const partsFor = (chars: number) => Math.max(1, Math.ceil(chars / PART_CHARS));
/** Length of part `i` of a `chars`-long base64 string. */
export const partLength = (chars: number, i: number) => Math.max(0, Math.min(PART_CHARS, chars - i * PART_CHARS));

export interface UploadSpec {
  path: string;
  mime: string;
  /** Base64 length. */
  size: number;
  parts: number;
}
