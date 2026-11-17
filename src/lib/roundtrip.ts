import { z } from "zod";
import { maskAnswers } from "./blocks";
import { assetMap } from "./context";
import { blockSchema, sectionSchema } from "./schema";
import { SCREEN_HEIGHT, type Block, type SectionData } from "./types";

// The return half of "Ask AI": the agent writes out/notebook.json (the bundle's format), the
// bridge uploads it, and the user reviews it section by section before anything is applied.

export interface ReturnedFile {
  path: string;
  mime: string;
  text?: string;
  base64?: string;
}

export const EDITABLE_FIELDS = ["title", "blocks", "solution", "marks", "timeLimitMinutes", "tags", "template", "kind", "objectives", "margin"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

// Images may point at an exported asset ("assets/…") or a file the agent returned ("out/…" or a
// bare relative path); those are resolved to data URLs before the normal import rules apply.
const returnedBlock = z.union([
  blockSchema,
  z.object({ type: z.literal("image"), src: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/), alt: z.string().optional(), width: z.number().min(0.1).max(1).optional(), caption: z.string().optional() }),
]);

const returnedSection = z.object({
  id: z.string().max(100).optional(),
  title: z.string().max(500).optional(),
  blocks: z.array(returnedBlock).max(500).optional(),
  solution: z.string().max(100_000).optional(),
  marks: z.number().nonnegative().optional(),
  timeLimitMinutes: z.number().positive().optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  template: z.enum(["plain", "dots", "grid", "lines"]).optional(),
  kind: sectionSchema.shape.kind,
  objectives: sectionSchema.shape.objectives,
  margin: sectionSchema.shape.margin,
});

const returnedNotebook = z.object({ sections: z.array(returnedSection).max(500) });

export type SectionChange =
  | { kind: "update"; id: string; index: number; title: string; fields: EditableField[]; patch: Partial<SectionData> }
  | { kind: "add"; title: string; data: Omit<SectionData, "order" | "createdAt"> };

export interface ParsedChanges {
  changes: SectionChange[];
  /** Sections or blocks that could not be used, with the reason. */
  problems: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function resolveImage(src: string, assets: Map<string, string>, returned: Map<string, ReturnedFile>): string | null {
  if (/^(https:|data:image\/)/.test(src)) return src;
  const clean = src.replace(/^\.\//, "");
  const known = assets.get(clean);
  if (known) return known;
  const f = returned.get(clean) ?? returned.get(clean.replace(/^out\//, ""));
  if (f?.base64 && /^image\/(png|jpeg|gif|webp)$/.test(f.mime)) return `data:${f.mime};base64,${f.base64}`;
  return null;
}

/**
 * Compares the agent's notebook.json against the live sections. Only fields present in the
 * returned JSON count, so leaving a field out (e.g. solutions that were not shared) keeps it.
 * Sections with an unknown id are ignored; nothing is ever deleted.
 */
export function parseReturnedNotebook(text: string, current: { id: string; data: SectionData }[], returnedFiles: ReturnedFile[] = []): ParsedChanges {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { changes: [], problems: [`notebook.json is not valid JSON: ${(e as Error).message}`] };
  }
  const parsed = returnedNotebook.safeParse(json);
  if (!parsed.success) return { changes: [], problems: parsed.error.issues.slice(0, 5).map((i) => `notebook.json ${i.path.join(".") || "(root)"}: ${i.message}`) };

  const assets = assetMap(current);
  const returned = new Map(returnedFiles.map((f) => [f.path.replace(/^out\//, ""), f]));
  const byId = new Map(current.map((s, i) => [s.id, { s, i }]));
  const seen = new Set<string>();
  const changes: SectionChange[] = [];
  const problems: string[] = [];

  parsed.data.sections.forEach((r, ri) => {
    const label = r.title?.trim() || (r.id && byId.get(r.id)?.s.data.title) || `returned section ${ri + 1}`;
    if (r.id && !byId.has(r.id)) return void problems.push(`"${label}": unknown section id${r.blocks ? "" : "; no blocks"}; skipped.`);
    const hitData = r.id ? byId.get(r.id)?.s.data : undefined;
    let blocks: Block[] | undefined;
    if (r.blocks) {
      blocks = [];
      for (const [bi, b] of r.blocks.entries()) {
        if (b.type !== "image") {
          // A block sent with its answers blanked and returned as is keeps the real answers.
          const cur = hitData?.blocks[bi];
          blocks.push(cur && cur !== maskAnswers(cur) && same(maskAnswers(cur), b) ? cur : (b as Block));
          continue;
        }
        const src = resolveImage(b.src, assets, returned);
        if (!src) {
          problems.push(`"${label}": image "${b.src}" is not one that was sent or returned, so this section was skipped.`);
          return;
        }
        blocks.push({ ...b, src });
      }
    }
    const hit = r.id ? byId.get(r.id) : undefined;
    if (hit) {
      if (seen.has(hit.s.id)) return void problems.push(`"${label}" appears twice; only the first copy was used.`);
      seen.add(hit.s.id);
      const patch: Partial<SectionData> = {};
      const fields: EditableField[] = [];
      const next = { ...r, blocks };
      for (const f of EDITABLE_FIELDS) {
        if (next[f] === undefined || same(next[f], hit.s.data[f])) continue;
        (patch as Record<string, unknown>)[f] = next[f];
        fields.push(f);
      }
      if (fields.length) changes.push({ kind: "update", id: hit.s.id, index: hit.i, title: hit.s.data.title?.trim() || `Section ${hit.i + 1}`, fields, patch });
      return;
    }
    if (!blocks) return void problems.push(`"${label}" is new but has no blocks, so it was skipped.`);
    changes.push({
      kind: "add",
      title: r.title?.trim() || "New section",
      data: {
        title: r.title,
        blocks,
        solution: r.solution,
        marks: r.marks,
        timeLimitMinutes: r.timeLimitMinutes,
        tags: r.tags,
        template: r.template ?? "plain",
        ...(r.kind ? { kind: r.kind } : {}),
        ...(r.objectives?.length ? { objectives: r.objectives } : {}),
        ...(r.margin ? { margin: r.margin } : {}),
        minHeight: Math.round(SCREEN_HEIGHT * 0.5),
      },
    });
  });
  return { changes, problems };
}

/** Applies a patch on top of the section's current data (other fields, ink and notes untouched). */
export function applyPatch(data: SectionData, patch: Partial<SectionData>): SectionData {
  const out = { ...data };
  for (const f of EDITABLE_FIELDS) if (f in patch) (out as Record<string, unknown>)[f] = patch[f];
  return out;
}
