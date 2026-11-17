import { reviewPayload, selectSections, payloadHash, type ReturnedFile } from "./ai-import";
import { payloadToSections } from "./payload";
import { applyImportedSections } from "./store";
import type { SectionData } from "./types";

export type ImportDestination = { kind: "new" } | { kind: "append"; notebookId: string };
export interface ImportApplication {
  raw: string;
  returned?: ReturnedFile[];
  selected: ReadonlySet<number>;
  destination: ImportDestination;
  /** Only an explicit acceptance may write. Closing a preview passes false. */
  accepted: boolean;
  jobId?: string;
  sources?: SectionData["sources"];
}

/** Review is pure; persistence happens only after explicit acceptance. */
export async function applyImport(input: ImportApplication) {
  if (!input.accepted) return null;
  const review = reviewPayload(input.raw, input.returned ?? []);
  const payload = selectSections(review, new Set(input.selected));
  if (!review.ok || !review.payload || !payload) throw new Error("Select at least one valid section before applying.");
  // Hash the complete reviewed result, not the selection or destination. A retry cannot
  // apply a different subset to another notebook after the result was already accepted.
  const bytes = new TextEncoder().encode(JSON.stringify(review.payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return applyImportedSections({
    receiptKey: key, destination: input.destination, title: payload.title,
    description: payload.description, sections: payloadToSections(payload).map((s) => ({ ...s, ...(input.sources ? { sources: input.sources } : {}) })),
    importHash: payloadHash(payload), legacyHashes: [payloadHash(payload), payloadHash(review.payload)], jobId: input.jobId,
  });
}
