import { z } from "zod";

// The padSync payload: what an AI (or a file) hands padSync to create a notebook. Versioned with
// `schemaVersion`; v1 files ("padsync": 1) are migrated. Parsing is forgiving on purpose: AI output
// is normalised first (aliases, unknown block types, out-of-range numbers), unknown fields are
// dropped with a warning, and each section is validated on its own so one bad section doesn't sink
// the rest. See docs/ai-import-2026-11-17.md.

export const SCHEMA_VERSION = 2;
export const MAX_PAYLOAD_CHARS = 8_000_000;
export const MAX_SECTIONS = 500;
export const MAX_BLOCKS = 500;
const MAX_TEXT = 100_000;

export const SPACE_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export const TEMPLATES = ["plain", "dots", "grid", "lines"] as const;
export const SECTION_KINDS = ["problem", "explanation", "worked-example", "notes", "summary", "review", "reference"] as const;
export const PURPOSES = ["practice", "understand", "annotate", "review", "mixed"] as const;
export const CALLOUT_STYLES = ["definition", "theorem", "key-idea", "intuition", "example", "warning", "tip", "mnemonic", "summary", "note"] as const;
export const STEP_STYLES = ["derivation", "worked-example", "procedure"] as const;
export const SPACE_MIN = 40;
export const SPACE_MAX = 4000;

/** https:, data:image/…, or a relative path to a file the agent returned (resolved at import). */
export const IMAGE_SRC_RE = /^(https:|data:image\/)/;
export const RELATIVE_SRC_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

type ObjectFactory = typeof z.object;

/** The same schemas twice: loose (unknown keys stripped) to parse, strict to find what was stripped. */
function build(obj: ObjectFactory) {
  const text = z.string().max(MAX_TEXT);
  const short = z.string().max(500);
  const space = z.union([z.enum(SPACE_SIZES), z.number().min(SPACE_MIN).max(SPACE_MAX)]);
  const list = <T extends z.ZodType>(t: T, max = 200) => z.array(t).max(max);

  const block = z.discriminatedUnion("type", [
    obj({ type: z.literal("markdown"), text }),
    obj({ type: z.literal("code"), language: short.optional(), code: text }),
    obj({
      type: z.literal("image"),
      src: z.string().max(MAX_PAYLOAD_CHARS).refine((s) => IMAGE_SRC_RE.test(s) || RELATIVE_SRC_RE.test(s), "must be an https:// URL, a data:image/ URL, or a returned file such as figures/graph.png"),
      alt: short.optional(),
      width: z.number().min(0.1).max(1).optional(),
      caption: short.optional(),
    }),
    obj({ type: z.literal("space"), size: space }),
    obj({ type: z.literal("divider") }),
    obj({ type: z.literal("callout"), style: z.enum(CALLOUT_STYLES), title: short.optional(), text }),
    obj({
      type: z.literal("steps"),
      style: z.enum(STEP_STYLES).optional(),
      title: short.optional(),
      problem: text.optional(),
      steps: list(obj({ text, why: text.optional() })).min(1),
      result: text.optional(),
      blankWhy: z.boolean().optional(),
    }),
    obj({
      type: z.literal("glossary"),
      title: short.optional(),
      terms: list(obj({ term: short, definition: text, example: text.optional() }), 300).min(1),
      hideDefinitions: z.boolean().optional(),
    }),
    obj({
      type: z.literal("conceptMap"),
      title: short.optional(),
      nodes: list(obj({ id: z.string().min(1).max(100), label: short, note: text.optional() }), 100).min(1),
      links: list(obj({ from: z.string().max(100), to: z.string().max(100), label: short.optional() }), 300).default([]),
    }),
    obj({ type: z.literal("cloze"), text: text.refine((s) => /\{\{[^{}]+\}\}/.test(s), "needs at least one {{blank}}"), hint: short.optional() }),
    obj({ type: z.literal("recall"), title: short.optional(), items: list(obj({ q: text, a: text.optional(), space: space.optional() })).min(1) }),
    obj({ type: z.literal("rewrite"), prompt: short.optional(), text, space: space.optional() }),
    obj({ type: z.literal("prompt"), text: short.min(1), space: space.optional() }),
    obj({ type: z.literal("checkpoint"), title: short.optional(), items: list(short).min(1), space: space.optional() }),
  ]);

  const section = obj({
    title: short.optional(),
    kind: z.enum(SECTION_KINDS).optional(),
    objectives: list(short, 20).optional(),
    blocks: z.array(block).max(MAX_BLOCKS),
    solution: text.optional(),
    timeLimitMinutes: z.number().positive().max(1000).optional(),
    marks: z.number().nonnegative().max(10_000).optional(),
    tags: list(z.string().max(100), 50).optional(),
    template: z.enum(TEMPLATES).optional(),
    margin: obj({ side: z.enum(["right", "left"]).optional(), width: z.number().min(0.15).max(0.45).optional(), prompts: list(short, 20).optional() }).optional(),
  });

  const head = obj({
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: z.string().trim().min(1, "is required (the notebook's name)").max(500),
    description: z.string().max(5000).optional(),
    subject: short.optional(),
    purpose: z.enum(PURPOSES).optional(),
    sections: z.array(z.unknown()).min(1, "needs at least one section").max(MAX_SECTIONS),
  });
  return { block, section, head };
}

const loose = build(z.object);
const strict = build(z.strictObject as unknown as ObjectFactory);

export const blockSchema = loose.block;
export const sectionSchema = loose.section;

export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export type PayloadSection = z.infer<typeof sectionSchema>;
export type SpaceSize = (typeof SPACE_SIZES)[number];
export type SectionKind = (typeof SECTION_KINDS)[number];
export type SectionMargin = NonNullable<PayloadSection["margin"]>;

export type Payload = Omit<z.infer<typeof loose.head>, "sections"> & { sections: PayloadSection[] };

export const BLOCK_TYPES: BlockType[] = ["markdown", "code", "image", "space", "divider", "callout", "steps", "glossary", "conceptMap", "cloze", "recall", "rewrite", "prompt", "checkpoint"];

// ---------------------------------------------------------------------------------------------
// Migrations: each lifts a payload one version. Add MIGRATIONS[2] when v3 arrives.

type Json = Record<string, unknown>;
export const MIGRATIONS: Record<number, (p: Json) => Json> = {
  // v1 is a strict subset of v2; only the version marker changed.
  1: (p) => {
    const out: Json = { ...p, schemaVersion: 2 };
    delete out.padsync;
    return out;
  },
};

export function migrate(json: Json, warnings: string[]): { json: Json; from: number } {
  const declared = json.schemaVersion ?? json.padsync;
  let v = typeof declared === "number" && Number.isInteger(declared) ? declared : typeof declared === "string" && /^\d+$/.test(declared) ? Number(declared) : null;
  if (v === null) {
    warnings.push(`(root): no schemaVersion; read as version ${SCHEMA_VERSION}.`);
    v = SCHEMA_VERSION;
  }
  const from = v;
  if (v > SCHEMA_VERSION) {
    warnings.push(`(root): made for a newer padSync (schemaVersion ${v}); read as version ${SCHEMA_VERSION}, so newer parts may be skipped.`);
    v = SCHEMA_VERSION;
  }
  if (v < 1) {
    warnings.push(`(root): schemaVersion ${v} is not a real version; read as version 1.`);
    v = 1;
  }
  let out: Json = json;
  while (v < SCHEMA_VERSION) out = MIGRATIONS[v++](out);
  const json2: Json = { ...out, schemaVersion: SCHEMA_VERSION };
  delete json2.padsync;
  return { json: json2, from };
}

// ---------------------------------------------------------------------------------------------
// Normalisation: forgive the usual AI spellings before validating.

const TYPE_ALIASES: Record<string, BlockType> = {
  markdown: "markdown", md: "markdown", text: "markdown", paragraph: "markdown", heading: "markdown", note: "markdown", math: "markdown", latex: "markdown", equation: "markdown",
  code: "code", codeblock: "code",
  image: "image", figure: "image", img: "image",
  space: "space", blank: "space", gap: "space", writingspace: "space", answerspace: "space", workspace: "space",
  divider: "divider", hr: "divider", rule: "divider", separator: "divider",
  callout: "callout", box: "callout", definition: "callout", theorem: "callout", keyidea: "callout", mnemonic: "callout", tip: "callout", warning: "callout", summary: "callout", intuition: "callout",
  steps: "steps", derivation: "steps", workedexample: "steps", example: "steps", procedure: "steps", stepbystep: "steps",
  glossary: "glossary", terms: "glossary", vocabulary: "glossary",
  conceptmap: "conceptMap", mindmap: "conceptMap", map: "conceptMap",
  cloze: "cloze", fillin: "cloze", fillintheblank: "cloze", fillintheblanks: "cloze", blanks: "cloze",
  recall: "recall", recallquestions: "recall", questions: "recall", flashcards: "recall", selftest: "recall",
  rewrite: "rewrite", ownwords: "rewrite", paraphrase: "rewrite", inyourownwords: "rewrite",
  prompt: "prompt", annotate: "prompt", annotation: "prompt", reflection: "prompt",
  checkpoint: "checkpoint", checklist: "checkpoint", review: "checkpoint",
};
const CALLOUT_FROM_TYPE: Record<string, string> = { definition: "definition", theorem: "theorem", keyidea: "key-idea", mnemonic: "mnemonic", tip: "tip", warning: "warning", summary: "summary", intuition: "intuition", box: "note" };
const CALLOUT_STYLE_ALIASES: Record<string, (typeof CALLOUT_STYLES)[number]> = {
  def: "definition", lemma: "theorem", corollary: "theorem", proposition: "theorem", law: "theorem", rule: "theorem", formula: "theorem",
  important: "key-idea", key: "key-idea", keypoint: "key-idea", insight: "intuition", caution: "warning", pitfall: "warning", mistake: "warning",
  hint: "tip", remark: "note", info: "note", recap: "summary", memory: "mnemonic",
};
const STEPS_FROM_TYPE: Record<string, string> = { derivation: "derivation", workedexample: "worked-example", example: "worked-example", procedure: "procedure" };
const SIZE_WORDS: Record<string, SpaceSize> = { xs: "xs", tiny: "xs", xsmall: "xs", s: "s", small: "s", short: "s", m: "m", medium: "m", md: "m", l: "l", large: "l", big: "l", xl: "xl", xlarge: "xl", huge: "xl", full: "xl", page: "xl" };

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const firstString = (o: Json, keys: string[]) => keys.map((k) => o[k]).find((v): v is string => typeof v === "string");

function normalizeSpace(v: unknown, at: string, warnings: string[]): unknown {
  if (typeof v === "string") {
    const w = SIZE_WORDS[key(v)];
    if (w) return w;
    if (/^\d+(px)?$/.test(v.trim())) v = Number.parseInt(v, 10);
  }
  if (typeof v === "number" && Number.isFinite(v) && (v < SPACE_MIN || v > SPACE_MAX)) {
    const c = Math.min(SPACE_MAX, Math.max(SPACE_MIN, Math.round(v)));
    warnings.push(`${at}: size ${v} is out of range; used ${c}.`);
    return c;
  }
  return v;
}

/** Returns the block to validate, or null to drop it (with a warning). */
export function normalizeBlock(raw: unknown, at: string, warnings: string[]): unknown {
  if (typeof raw === "string") return { type: "markdown", text: raw };
  if (!isObj(raw)) return raw;
  const b: Json = { ...raw };
  const t = typeof b.type === "string" ? key(b.type) : "";
  const type = TYPE_ALIASES[t];
  if (!type) {
    const text = firstString(b, ["text", "content", "markdown", "body", "md"]);
    if (text !== undefined) {
      warnings.push(`${at}: unknown block type ${JSON.stringify(b.type ?? null)}; kept its text as markdown.`);
      return { type: "markdown", text };
    }
    warnings.push(`${at}: unknown block type ${JSON.stringify(b.type ?? null)} with no text; left out.`);
    return null;
  }
  b.type = type;
  if (type === "markdown" || type === "callout" || type === "rewrite" || type === "prompt" || type === "cloze") {
    if (typeof b.text !== "string") {
      const text = firstString(b, ["content", "markdown", "body", "md", "value", "latex"]);
      if (text !== undefined) b.text = text;
    }
    for (const k of ["content", "markdown", "body", "md", "value", "latex"]) if (typeof raw[k] === "string" && b.text === raw[k]) delete b[k];
  }
  if (type === "markdown" && (t === "math" || t === "latex" || t === "equation") && typeof b.text === "string" && !b.text.includes("$")) b.text = `$$${b.text}$$`;
  if (type === "callout") {
    if (typeof b.style === "string") {
      const s = key(b.style);
      const style = CALLOUT_STYLE_ALIASES[s] ?? CALLOUT_STYLES.find((c) => key(c) === s);
      if (!style) warnings.push(`${at} › style: unknown callout style ${JSON.stringify(b.style)}; shown as a note.`);
      b.style = style ?? "note";
    } else b.style = CALLOUT_FROM_TYPE[t] ?? "note";
  }
  if (type === "steps" && b.style === undefined && STEPS_FROM_TYPE[t]) b.style = STEPS_FROM_TYPE[t];
  if (type === "steps" && Array.isArray(b.steps)) b.steps = b.steps.map((s) => (typeof s === "string" ? { text: s } : s));
  if (type === "recall" && Array.isArray(b.items))
    b.items = b.items.map((it) => {
      if (typeof it === "string") return { q: it };
      if (!isObj(it)) return it;
      const o = { ...it };
      if (o.q === undefined && typeof o.question === "string") [o.q, o.question] = [o.question, undefined];
      if (o.a === undefined && typeof o.answer === "string") [o.a, o.answer] = [o.answer, undefined];
      return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    });
  if (type === "glossary" && isObj(b.terms)) b.terms = Object.entries(b.terms).map(([term, definition]) => ({ term, definition }));
  if (type === "conceptMap") {
    if (b.links === undefined && Array.isArray(b.edges)) {
      b.links = b.edges;
      delete b.edges;
    }
    if (Array.isArray(b.nodes)) b.nodes = b.nodes.map((n, i) => (typeof n === "string" ? { id: n, label: n } : isObj(n) && n.id === undefined && typeof n.label === "string" ? { ...n, id: n.label || String(i) } : n));
  }
  if (type === "space" && b.size === undefined) b.size = b.lines !== undefined ? Math.round(Number(b.lines) * 60) : "m";
  if (type === "space" && b.lines !== undefined) delete b.lines;
  if (b.size !== undefined && (type === "space" || type === "rewrite" || type === "prompt" || type === "checkpoint")) b.size = normalizeSpace(b.size, `${at} › size`, warnings);
  if (b.space !== undefined) b.space = normalizeSpace(b.space, `${at} › space`, warnings);
  if (type === "rewrite" || type === "prompt" || type === "checkpoint") {
    if (b.space === undefined && b.size !== undefined) b.space = b.size;
    delete b.size;
  }
  if (type === "recall" && Array.isArray(b.items))
    b.items = (b.items as unknown[]).map((it, i) => (isObj(it) && it.space !== undefined ? { ...it, space: normalizeSpace(it.space, `${at} › items[${i}] › space`, warnings) } : it));
  if (type === "image" && typeof b.width === "number" && b.width > 1 && b.width <= 100) {
    warnings.push(`${at} › width: ${b.width} read as ${b.width}%.`);
    b.width = Math.max(0.1, b.width / 100);
  }
  return b;
}

function normalizeSection(raw: unknown, at: string, warnings: string[]): unknown {
  if (!isObj(raw)) return raw;
  const s: Json = { ...raw };
  if (s.blocks === undefined) {
    const text = firstString(s, ["text", "content", "markdown", "body"]);
    if (text !== undefined) {
      warnings.push(`${at}: no blocks; used its text as one markdown block.`);
      s.blocks = [{ type: "markdown", text }];
      for (const k of ["text", "content", "markdown", "body"]) if (s[k] === text) delete s[k];
    }
  }
  if (typeof s.kind === "string") s.kind = s.kind.toLowerCase().replace(/[\s_]+/g, "-");
  if (typeof s.template === "string") s.template = s.template.toLowerCase();
  if (typeof s.tags === "string") s.tags = [s.tags];
  if (s.margin === true) s.margin = {};
  if (typeof s.objectives === "string") s.objectives = [s.objectives];
  if (Array.isArray(s.blocks)) {
    const out: unknown[] = [];
    s.blocks.forEach((b, i) => {
      const n = normalizeBlock(b, `${at} › blocks[${i}]`, warnings);
      if (n !== null) out.push(n);
    });
    s.blocks = out;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Errors that point at the offending path.

function describePath(path: PropertyKey[], value: unknown): string {
  let out = "";
  let cur: unknown = value;
  for (const seg of path) {
    const next = isObj(cur) || Array.isArray(cur) ? (cur as Record<PropertyKey, unknown>)[seg as never] : undefined;
    if (typeof seg === "number") {
      out += `[${seg}]`;
      if (isObj(next) && typeof next.type === "string") out += ` (${next.type})`;
    } else out += (out ? " › " : "") + String(seg);
    cur = next;
  }
  return out;
}

export function humanizeIssue(i: z.core.$ZodIssue): string {
  const anyI = i as z.core.$ZodIssue & { expected?: string; values?: unknown[]; minimum?: number | bigint; maximum?: number | bigint; origin?: string; keys?: string[]; input?: unknown };
  switch (i.code) {
    case "invalid_type":
      return /received undefined/.test(i.message) ? `required (${anyI.expected})` : `expected ${anyI.expected}${/received (\w+)/.test(i.message) ? `, got ${/received (\w+)/.exec(i.message)![1]}` : ""}`;
    case "invalid_value":
      return `must be ${anyI.values!.length === 1 ? JSON.stringify(anyI.values![0]) : `one of ${anyI.values!.map((v) => JSON.stringify(v)).join(", ")}`}`;
    case "too_small":
      return anyI.origin === "array" ? `needs at least ${anyI.minimum} item${Number(anyI.minimum) === 1 ? "" : "s"}` : anyI.origin === "string" ? (Number(anyI.minimum) === 1 ? "must not be empty" : `must be at least ${anyI.minimum} characters`) : `must be at least ${anyI.minimum}`;
    case "too_big":
      return anyI.origin === "array" ? `has more than ${anyI.maximum} items` : anyI.origin === "string" ? `is longer than ${anyI.maximum} characters` : `must be at most ${anyI.maximum}`;
    case "invalid_union":
      return /type/.test(String(i.path.at(-1) ?? "")) || (i as { note?: string }).note === "No matching discriminator" ? `type must be one of ${BLOCK_TYPES.join(", ")}` : "doesn't match any allowed shape";
    case "unrecognized_keys":
      return `unknown field${anyI.keys!.length === 1 ? "" : "s"} ${anyI.keys!.map((k) => JSON.stringify(k)).join(", ")}`;
    default:
      return i.message;
  }
}

const where = (prefix: string, p: string) => (prefix && p ? `${prefix} › ${p}` : prefix || p || "(root)");

function issues(err: z.ZodError, prefix: string, value: unknown) {
  return err.issues.slice(0, 8).map((i) => `${where(prefix, describePath(i.path, value))}: ${humanizeIssue(i)}`);
}

function unknownKeyWarnings(schema: z.ZodType, value: unknown, prefix: string): string[] {
  const r = schema.safeParse(value);
  if (r.success) return [];
  return r.error.issues
    .filter((i) => i.code === "unrecognized_keys")
    .map((i) => `${where(prefix, describePath(i.path, value))}: ${humanizeIssue(i)} ignored.`);
}

// ---------------------------------------------------------------------------------------------
// Parsing

export interface SectionReport {
  index: number;
  title: string;
  ok: boolean;
  errors: string[];
  section?: PayloadSection;
}

export interface ParseResult {
  /** True when the head is valid and at least one section is. */
  ok: boolean;
  /** Only the valid sections. */
  payload: Payload | null;
  sections: SectionReport[];
  /** Fatal problems, then per-section ones. */
  errors: string[];
  warnings: string[];
  /** Version the input declared (1 for legacy files). */
  fromVersion: number | null;
}

const fail = (error: string, warnings: string[] = []): ParseResult => ({ ok: false, payload: null, sections: [], errors: [error], warnings, fromVersion: null });

/** Pulls the JSON object out of a chat reply: tolerates ```json fences and prose around it. */
export function extractJson(raw: string): string {
  const fences = [...raw.matchAll(/```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  // With several fenced blocks, the payload is the object with sections (an example or metadata
  // object may come first), else the first object.
  const fenced = fences.find((f) => f.startsWith("{") && /"sections"\s*:/.test(f)) ?? fences.find((f) => f.startsWith("{")) ?? fences[0];
  let text = (fenced ?? raw).trim().replace(/^﻿/, "");
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  return text;
}

function objectCandidates(text: string): unknown {
  const end = text.lastIndexOf("}");
  for (let i = text.indexOf("{", 1); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    if (!/^\{\s*"/.test(text.slice(i, i + 20))) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {}
  }
  return undefined;
}

export function parsePayloadText(raw: string): ParseResult {
  if (raw.length > MAX_PAYLOAD_CHARS) return fail(`The JSON is ${(raw.length / 1e6).toFixed(1)} MB; the limit is ${MAX_PAYLOAD_CHARS / 1e6} MB.`);
  const text = extractJson(raw);
  if (!text) return fail("Nothing to import: paste the AI's JSON reply.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // Prose with braces before the JSON ("use {x} notation: {…}"): try each object start.
    const retry = objectCandidates(text);
    if (retry !== undefined) return parsePayloadValue(retry);
    const msg = (e as Error).message;
    const pos = /position (\d+)/.exec(msg);
    const where = pos ? ` (line ${text.slice(0, Number(pos[1])).split("\n").length})` : "";
    const hint = /\\/.test(text) && /Bad escaped|escape/i.test(msg) ? " LaTeX backslashes must be doubled in JSON (\\\\int, not \\int)." : "";
    return fail(`Not valid JSON${where}: ${msg}.${hint}`);
  }
  return parsePayloadValue(json);
}

export function parsePayloadValue(input: unknown): ParseResult {
  const warnings: string[] = [];
  if (Array.isArray(input)) return fail("(root): expected an object with title and sections, got an array.");
  if (!isObj(input)) return fail(`(root): expected an object with title and sections, got ${input === null ? "null" : typeof input}.`);
  const { json, from } = migrate(input, warnings);
  if (typeof json.title !== "string" || !json.title.trim()) {
    const fallback = typeof json.name === "string" && json.name.trim() ? json.name.trim() : null;
    if (fallback) {
      json.title = fallback;
      delete json.name;
      warnings.push(`(root): used "name" as the title.`);
    }
  }
  const head = loose.head.safeParse(json);
  if (!head.success) return { ...fail("", warnings), errors: issues(head.error, "", json), fromVersion: from };
  warnings.push(...unknownKeyWarnings(strict.head, json, ""));

  const reports: SectionReport[] = head.data.sections.map((raw, i) => {
    const title = isObj(raw) && typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : `Section ${i + 1}`;
    const prefix = `sections[${i}] ${JSON.stringify(title)}`;
    if (!isObj(raw)) return { index: i, title, ok: false, errors: [`${prefix}: expected an object, got ${Array.isArray(raw) ? "an array" : typeof raw}`] };
    const sectionWarnings: string[] = [];
    const n = normalizeSection(raw, prefix, sectionWarnings);
    const r = loose.section.safeParse(n);
    if (!r.success) return { index: i, title, ok: false, errors: issues(r.error, prefix, n) };
    warnings.push(...sectionWarnings, ...unknownKeyWarnings(strict.section, n, prefix));
    const missing = conceptMapProblems(r.data, prefix);
    if (missing.length) return { index: i, title, ok: false, errors: missing };
    return { index: i, title, ok: true, errors: [], section: r.data };
  });
  const valid = reports.filter((r) => r.ok).map((r) => r.section!);
  const errors = reports.flatMap((r) => r.errors);
  if (!valid.length) errors.unshift("No section could be imported.");
  return {
    ok: valid.length > 0,
    payload: valid.length ? { ...head.data, sections: valid } : null,
    sections: reports,
    errors,
    warnings,
    fromVersion: from,
  };
}

function conceptMapProblems(s: PayloadSection, prefix: string): string[] {
  const out: string[] = [];
  s.blocks.forEach((b, i) => {
    if (b.type !== "conceptMap") return;
    const ids = new Set<string>();
    b.nodes.forEach((n, j) => {
      if (ids.has(n.id)) out.push(`${prefix} › blocks[${i}] (conceptMap) › nodes[${j}] › id: ${JSON.stringify(n.id)} is used twice`);
      ids.add(n.id);
    });
    b.links.forEach((l, j) => {
      for (const end of ["from", "to"] as const) if (!ids.has(l[end])) out.push(`${prefix} › blocks[${i}] (conceptMap) › links[${j}] › ${end}: no node with id ${JSON.stringify(l[end])}`);
    });
  });
  return out;
}
