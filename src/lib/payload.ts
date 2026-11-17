import { SCHEMA_VERSION, blockSchema, parsePayloadText, type Payload, type PayloadSection } from "./schema";
import { SCREEN_HEIGHT, type SectionData } from "./types";

// The import contract for AI-generated material. Layout is flow-based on purpose: the AI
// describes content and how much writing space to leave; padSync does the positioning.
// The schema itself (versions, migration, tolerant parsing) lives in ./schema.

export { blockSchema };
export type { Payload };

/** Strict all-or-nothing parse, for callers that don't offer a partial import. */
export function parsePayload(raw: string): { ok: true; payload: Payload; warnings: string[] } | { ok: false; error: string } {
  const r = parsePayloadText(raw);
  if (!r.ok || r.errors.length) return { ok: false, error: r.errors.join("\n") };
  return { ok: true, payload: r.payload!, warnings: r.warnings };
}

const NOTE_KINDS = new Set(["notes", "summary", "reference", "explanation", "worked-example"]);

export function sectionToData(s: PayloadSection): Omit<SectionData, "order" | "createdAt"> {
  // Problems need room to work; notes sections grow with their content anyway.
  const notes = s.kind != null && NOTE_KINDS.has(s.kind);
  return {
    title: s.title,
    blocks: s.blocks,
    solution: s.solution,
    timeLimitMinutes: s.timeLimitMinutes,
    marks: s.marks,
    tags: s.tags,
    template: s.template ?? (s.kind === "notes" ? "lines" : "plain"),
    ...(s.kind ? { kind: s.kind } : {}),
    ...(s.objectives?.length ? { objectives: s.objectives } : {}),
    ...(s.margin ? { margin: s.margin } : {}),
    minHeight: Math.round(SCREEN_HEIGHT * (notes ? 0.3 : 0.5)),
  };
}

export function payloadToSections(p: Pick<Payload, "sections">): Omit<SectionData, "order" | "createdAt">[] {
  return p.sections.map(sectionToData);
}

export const EXAMPLE_PAYLOAD: Payload = {
  schemaVersion: SCHEMA_VERSION,
  title: "MA1521 · Week 5 · Integration by parts",
  description: "Organised notes, a worked example and practice from Lecture 9.",
  subject: "Calculus",
  purpose: "mixed",
  sections: [
    {
      title: "Integration by parts: notes",
      kind: "notes",
      objectives: ["Derive the formula from the product rule", "Choose u with LIATE"],
      margin: { side: "right", width: 0.3, prompts: ["Where does the minus sign come from?", "Link to the product rule"] },
      blocks: [
        { type: "callout", style: "theorem", title: "Integration by parts", text: "For differentiable $u, v$:\n\n$$\\int u\\,dv = uv - \\int v\\,du$$" },
        {
          type: "steps",
          style: "derivation",
          title: "Where it comes from",
          steps: [
            { text: "$(uv)' = u'v + uv'$", why: "Product rule" },
            { text: "$\\int (uv)'\\,dx = \\int u'v\\,dx + \\int uv'\\,dx$", why: "Integrate both sides" },
            { text: "$\\int uv'\\,dx = uv - \\int u'v\\,dx$", why: "Rearrange; the left side integrates to $uv$" },
          ],
          blankWhy: true,
        },
        { type: "cloze", text: "Choose $u$ by LIATE: {{Logarithmic}}, Inverse trig, {{Algebraic}}, Trig, {{Exponential}}." },
        { type: "rewrite", prompt: "Explain in your own words when integration by parts helps.", text: "It trades an integral for one that is easier, by moving a derivative from one factor to the other.", space: "s" },
        { type: "glossary", terms: [{ term: "LIATE", definition: "A rule of thumb for choosing $u$: the earlier in the list, the better a choice for $u$." }] },
      ],
    },
    {
      title: "Worked example",
      kind: "worked-example",
      blocks: [
        {
          type: "steps",
          style: "worked-example",
          problem: "Find $\\displaystyle\\int x e^{2x}\\,dx$.",
          steps: [
            { text: "Let $u = x$, $dv = e^{2x}dx$, so $du = dx$, $v = \\tfrac12 e^{2x}$.", why: "Algebraic before exponential (LIATE)" },
            { text: "$\\int x e^{2x}dx = \\tfrac{x}{2}e^{2x} - \\int \\tfrac12 e^{2x}dx$" },
          ],
          result: "$\\tfrac{x}{2}e^{2x} - \\tfrac14 e^{2x} + C$",
        },
      ],
    },
    {
      title: "Q1",
      kind: "problem",
      marks: 3,
      timeLimitMinutes: 5,
      tags: ["integration-by-parts"],
      blocks: [
        { type: "markdown", text: "Evaluate $\\displaystyle\\int x^2 \\ln x\\,dx$." },
        { type: "space", size: "l" },
      ],
      solution: "Let $u = \\ln x$, $dv = x^2dx$. Then $\\int x^2\\ln x\\,dx = \\tfrac{x^3}{3}\\ln x - \\tfrac{x^3}{9} + C$.",
    },
    {
      title: "Check yourself",
      kind: "review",
      blocks: [
        { type: "recall", items: [{ q: "State the integration by parts formula.", a: "$\\int u\\,dv = uv - \\int v\\,du$", space: "s" }] },
        { type: "checkpoint", items: ["I can derive the formula", "I can pick $u$ quickly"] },
      ],
    },
  ],
};

export interface Goal {
  id: string;
  label: string;
  guidance: string;
}

/** What the user can ask for; each adds guidance to the prompt. */
export const GOALS: Goal[] = [
  { id: "practice", label: "Practice problems", guidance: "Practice problems: one per section (kind \"problem\"), increasing difficulty, each with marks, a generous \"space\" block and a full worked \"solution\"." },
  { id: "explain", label: "Explanations & worked examples", guidance: "Understanding: explain each key idea (callouts for definitions/theorems/intuition), then a \"steps\" worked example or derivation with the reason for each step in \"why\"." },
  { id: "map", label: "Concept map & summary", guidance: "Big picture: a conceptMap of how the main ideas connect, and a short summary callout per topic." },
  { id: "glossary", label: "Glossary & mnemonics", guidance: "Vocabulary: a glossary of the terms and notation used, and mnemonic callouts where they genuinely help." },
  { id: "skeleton", label: "Note skeleton with blanks", guidance: "Note skeleton for handwriting: organise the lecture into notes sections (kind \"notes\", template \"lines\"), with key terms and results as {{cloze}} blanks, derivations with blankWhy: true, and rewrite blocks for the core ideas." },
  { id: "margins", label: "Margins & annotation prompts", guidance: "Annotation: give notes sections a margin with 2–3 prompts (questions to answer, links to make), and add prompt blocks where I should sketch, connect or summarise." },
  { id: "recall", label: "Recall questions & checkpoints", guidance: "Retrieval practice: end each topic with a recall block (answers in \"a\") and a checkpoint list of what I should now be able to do." },
  { id: "test", label: "Timed test", guidance: "Timed test: questions with marks and timeLimitMinutes that add up to a realistic paper; solutions hidden." },
];

export interface PromptOptions {
  request: string;
  goals?: string[];
  /** Original names of the attached lecture files, in order. */
  files?: string[];
  /** "file": the bridge, the agent writes out/padsync.json. "chat": pasted into a chat by hand. */
  delivery?: "chat" | "file";
}

export function buildPrompt(input: string | PromptOptions) {
  const o: PromptOptions = typeof input === "string" ? { request: input } : input;
  const goals = GOALS.filter((g) => o.goals?.includes(g.id));
  const file = o.delivery === "file";
  return `You are preparing study material for padSync, an iPad note-taking app where I write with an Apple Pencil on top of what you produce.
Read the attached lecture material and produce ONE JSON object in the format below. ${file ? "Write it to the file named in your instructions." : "Reply with only the JSON (no prose before or after)."}

FORMAT (schemaVersion ${SCHEMA_VERSION})
{
  "schemaVersion": ${SCHEMA_VERSION},
  "title": string,
  "description"?: string,
  "subject"?: string,
  "purpose"?: "practice" | "understand" | "annotate" | "review" | "mixed",
  "sections": Section[]
}
Section = {
  "title"?: string,              // e.g. "Q3" or "Taylor series: notes"
  "kind"?: "problem" | "explanation" | "worked-example" | "notes" | "summary" | "review" | "reference",
  "objectives"?: string[],       // learning goals shown under the title
  "blocks": Block[],             // rendered top to bottom
  "solution"?: string,           // markdown + LaTeX; HIDDEN from me, used later to check my work
  "timeLimitMinutes"?: number,
  "marks"?: number,
  "tags"?: string[],             // topic tags
  "template"?: "plain" | "dots" | "grid" | "lines",   // writing background
  "margin"?: { "side"?: "right" | "left", "width"?: number (0.15–0.45 of the page), "prompts"?: string[] }
                                 // a ruled column beside the content for my annotations
}
Size = "xs" | "s" | "m" | "l" | "xl" | number   // writing space: xs≈2 lines, s≈4, m≈7, l≈11, xl≈15 (or pixels, 40–4000)
Block =
  | { "type": "markdown", "text": string }          // GitHub markdown; LaTeX with $...$ and $$...$$
  | { "type": "code", "language"?: string, "code": string }
  | { "type": "image", "src": string, "alt"?: string, "width"?: number, "caption"?: string }
      // src: https://… or data:image/…${file ? "; or a figure you saved, e.g. \"figures/graph.png\"" : ""}; width = fraction of the content width (0.1–1)
  | { "type": "space", "size": Size }               // blank space for me to write in
  | { "type": "divider" }
  | { "type": "callout", "style": "definition" | "theorem" | "key-idea" | "intuition" | "example" | "warning" | "tip" | "mnemonic" | "summary" | "note", "title"?: string, "text": string }
  | { "type": "steps", "style"?: "derivation" | "worked-example" | "procedure", "title"?: string, "problem"?: string,
      "steps": [{ "text": string, "why"?: string }], "result"?: string, "blankWhy"?: boolean }
      // numbered steps; "why" justifies each step; blankWhy: true hides the reasons and leaves me a line to fill in
  | { "type": "glossary", "title"?: string, "terms": [{ "term": string, "definition": string, "example"?: string }], "hideDefinitions"?: boolean }
  | { "type": "conceptMap", "title"?: string, "nodes": [{ "id": string, "label": string, "note"?: string }], "links": [{ "from": id, "to": id, "label"?: string }] }
  | { "type": "cloze", "text": string, "hint"?: string }   // fill-in-the-blank: mark each blank as {{answer}}; answers stay hidden until I reveal them
  | { "type": "recall", "title"?: string, "items": [{ "q": string, "a"?: string, "space"?: Size }] }   // questions to answer from memory; "a" is hidden
  | { "type": "rewrite", "prompt"?: string, "text": string, "space"?: Size }  // a passage for me to rewrite in my own words, with lined space
  | { "type": "prompt", "text": string, "space"?: Size }   // an annotation cue ("Sketch…", "Connect this to…") followed by space
  | { "type": "checkpoint", "title"?: string, "items": string[], "space"?: Size }   // "I can…" statements I tick off

HOW TO USE IT
- Do not position anything; padSync lays blocks out vertically on a landscape iPad page (1376px wide, ~1032px per screen).
- Every question needs room to answer: a "space" block after it (be generous for multi-step work), or "space" on recall items.
- For practice or tests, use one question per section. For explanations and note skeletons, organize each section around a coherent topic. Put shared context (definitions, a lecture excerpt) in its own section first.
- For understanding: callouts for definitions and theorems, "steps" for derivations and worked examples (always say why), a conceptMap for how ideas connect.
- For handwritten notes on top: kind "notes" sections that follow the lecture's structure, with cloze blanks for the key facts, blankWhy derivations, rewrite and prompt blocks, and a margin with prompts. Leave real space; I will write in it.
- Hidden material (solution, cloze answers, recall "a", "why" with blankWhy) must be correct and complete: I use it to check myself.
- Stay faithful to the lecture: same notation, same order, nothing invented. Mention the slide/page in a tag or caption when useful.
- JSON strings: escape backslashes (write "\\\\int" to get \\int) and newlines (\\n).${file ? "\n- If you include a figure from the material, save it as a PNG or JPEG under the figures folder named in your instructions and reference it by that relative path." : ""}
${goals.length ? `\nWHAT I WANT\n${goals.map((g) => `- ${g.guidance}`).join("\n")}\n` : ""}${o.files?.length ? `\nATTACHED MATERIAL (in this order)\n${o.files.map((f, i) => `${i + 1}. ${f.replace(/[\r\n]+/g, " ")}`).join("\n")}\n` : ""}
MY REQUEST
${o.request.trim() || "(Describe what to generate: e.g. organised notes with blanks for Lecture 9, then 6 practice problems.)"}

EXAMPLE
${JSON.stringify(EXAMPLE_PAYLOAD, null, 2)}`;
}
