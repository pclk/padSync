import { z } from "zod";
import { SCREEN_HEIGHT, type SectionData } from "./types";

// The import contract for AI-generated material. Layout is flow-based on purpose: the AI
// describes content and how much writing space to leave; padSync does the positioning.

const spaceSize = z.union([z.enum(["xs", "s", "m", "l", "xl"]), z.number().min(40).max(4000)]);

export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), text: z.string() }),
  z.object({ type: z.literal("code"), language: z.string().optional(), code: z.string() }),
  z.object({
    type: z.literal("image"),
    src: z.string().refine((s) => /^(https:|data:image\/)/.test(s), "src must be https: or data:image/"),
    alt: z.string().optional(),
    width: z.number().min(0.1).max(1).optional(),
    caption: z.string().optional(),
  }),
  z.object({ type: z.literal("space"), size: spaceSize }),
  z.object({ type: z.literal("divider") }),
]);

export const sectionSchema = z.object({
  title: z.string().optional(),
  blocks: z.array(blockSchema),
  solution: z.string().optional(),
  timeLimitMinutes: z.number().positive().optional(),
  marks: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  template: z.enum(["plain", "dots", "grid", "lines"]).optional(),
});

export const payloadSchema = z.object({
  padsync: z.literal(1),
  title: z.string().min(1),
  description: z.string().optional(),
  sections: z.array(sectionSchema).min(1),
});

export type Payload = z.infer<typeof payloadSchema>;

/** Accepts raw text from a chat reply: tolerates ```json fences and surrounding prose. */
export function parsePayload(raw: string): { ok: true; payload: Payload } | { ok: false; error: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  let text = (fenced ? fenced[1] : raw).trim();
  if (!fenced) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  const result = payloadSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") };
  }
  return { ok: true, payload: result.data };
}

export function payloadToSections(p: Payload): Omit<SectionData, "order" | "createdAt">[] {
  return p.sections.map((s) => ({
    title: s.title,
    blocks: s.blocks,
    solution: s.solution,
    timeLimitMinutes: s.timeLimitMinutes,
    marks: s.marks,
    tags: s.tags,
    template: s.template ?? "plain",
    minHeight: Math.round(SCREEN_HEIGHT * 0.5),
  }));
}

export const EXAMPLE_PAYLOAD: Payload = {
  padsync: 1,
  title: "MA1521 · Week 5 · Integration by parts",
  description: "Warm-up set generated from Lecture 9.",
  sections: [
    {
      title: "Key idea",
      template: "plain",
      blocks: [
        { type: "markdown", text: "**Integration by parts.** For differentiable $u, v$:\n\n$$\\int u\\,dv = uv - \\int v\\,du$$\n\nPick $u$ by LIATE: Logarithmic, Inverse trig, Algebraic, Trig, Exponential." },
        { type: "space", size: "s" },
      ],
    },
    {
      title: "Q1",
      marks: 3,
      timeLimitMinutes: 5,
      tags: ["integration-by-parts"],
      blocks: [
        { type: "markdown", text: "Evaluate $\\displaystyle\\int x e^{2x}\\,dx$." },
        { type: "space", size: "l" },
      ],
      solution: "Let $u = x$, $dv = e^{2x}dx$. Then $\\int x e^{2x}dx = \\tfrac{x}{2}e^{2x} - \\tfrac14 e^{2x} + C$.",
    },
  ],
};

export function buildPrompt(extra: string) {
  return `You are preparing study material for padSync, an iPad note-taking app where I annotate with an Apple Pencil.
Read the attached lecture material and produce ONE JSON object (no prose before or after) in this exact format.

FORMAT
{
  "padsync": 1,
  "title": string,
  "description"?: string,
  "sections": Section[]
}
Section = {
  "title"?: string,              // e.g. "Q3" or "Recap: Taylor series"
  "blocks": Block[],             // rendered top to bottom
  "solution"?: string,           // markdown + LaTeX; HIDDEN from me, used later to grade my work
  "timeLimitMinutes"?: number,
  "marks"?: number,
  "tags"?: string[],             // topic tags for analytics
  "template"?: "plain" | "dots" | "grid" | "lines"   // writing background, default "plain"
}
Block =
  | { "type": "markdown", "text": string }          // GitHub markdown; LaTeX with $...$ and $$...$$
  | { "type": "code", "language"?: string, "code": string }
  | { "type": "image", "src": string, "alt"?: string, "width"?: number, "caption"?: string }
                                                      // src must be https:// or data:image/...; width = fraction of page width (0.1–1)
  | { "type": "space", "size": "xs" | "s" | "m" | "l" | "xl" | number }
                                                      // blank writing space: xs≈2 lines, s≈4, m≈7, l≈11, xl≈15 (or pixels)
  | { "type": "divider" }

LAYOUT RULES
- Do not try to position anything; padSync lays blocks out vertically on a landscape iPad page (1376px wide, ~1032px per screen).
- After every question, add a "space" block sized to the working I will need. Be generous for multi-step problems.
- One question per section. Put shared context (definitions, a lecture excerpt) in its own section first.
- Escape backslashes properly for JSON: write "\\\\int" in JSON to get \\int.
- Always include a worked "solution" for every question.

MY REQUEST
${extra.trim() || "(Describe what to generate: e.g. 8 practice problems on integration by parts, increasing difficulty.)"}

EXAMPLE
${JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}`;
}
