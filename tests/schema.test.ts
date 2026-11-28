import { describe, expect, it } from "vitest";
import { MAX_PAYLOAD_CHARS, MIGRATIONS, SCHEMA_VERSION, extractJson, migrate, parsePayloadText, parsePayloadValue } from "@/lib/schema";

// The v2 payload schema: validation, tolerance of AI output, unknown fields, old versions,
// migration, and error messages that point at the offending path.

const v2 = (sections: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 2, title: "T", sections, ...extra });
const one = (blocks: unknown[], section: Record<string, unknown> = {}) => parsePayloadValue(v2([{ title: "S", blocks, ...section }]));

describe("valid payloads", () => {
  it("accepts every study block and section field", () => {
    const r = one(
      [
        { type: "callout", style: "mnemonic", title: "SOH CAH TOA", text: "sin = opp/hyp" },
        { type: "steps", style: "derivation", problem: "Show $a$", steps: [{ text: "x", why: "y" }], result: "z", blankWhy: true },
        { type: "glossary", title: "Terms", terms: [{ term: "a", definition: "b", example: "c" }], hideDefinitions: true },
        { type: "conceptMap", nodes: [{ id: "a", label: "A", note: "n" }, { id: "b", label: "B" }], links: [{ from: "a", to: "b", label: "implies" }] },
        { type: "cloze", text: "The {{derivative}} of $\\sin x$ is {{$\\cos x$}}.", hint: "calculus" },
        { type: "recall", title: "Quiz", items: [{ q: "Q?", a: "A", space: "m" }, { q: "Q2?" }] },
        { type: "rewrite", prompt: "Own words", text: "Passage", space: 300 },
        { type: "prompt", text: "Sketch it", space: "l" },
        { type: "checkpoint", title: "Can I…", items: ["do x"], space: "xs" },
        { type: "image", src: "figures/graph.png", alt: "g", width: 0.5 },
      ],
      { kind: "notes", objectives: ["Know x"], margin: { side: "left", width: 0.25, prompts: ["Why?"] }, template: "lines" },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.payload!.sections[0]).toMatchObject({ kind: "notes", objectives: ["Know x"], margin: { side: "left", width: 0.25 } });
    expect(r.payload!.sections[0].blocks).toHaveLength(10);
  });

  it("keeps the head fields and defaults concept map links", () => {
    const r = parsePayloadValue(v2([{ blocks: [{ type: "conceptMap", nodes: [{ id: "a", label: "A" }] }] }], { description: "d", subject: "Calc", purpose: "annotate" }));
    expect(r.payload).toMatchObject({ schemaVersion: 2, title: "T", description: "d", subject: "Calc", purpose: "annotate" });
    expect(r.payload!.sections[0].blocks[0]).toMatchObject({ links: [] });
  });
});

describe("old versions and migration", () => {
  const v1 = { padsync: 1, title: "Old", description: "x", sections: [{ title: "Q1", marks: 3, timeLimitMinutes: 5, tags: ["t"], template: "grid", blocks: [{ type: "markdown", text: "Evaluate $x$" }, { type: "space", size: "l" }, { type: "divider" }, { type: "code", language: "py", code: "print(1)" }], solution: "s" }] };

  it("imports a v1 export unchanged except for the version", () => {
    const r = parsePayloadValue(v1);
    expect(r.ok).toBe(true);
    expect(r.fromVersion).toBe(1);
    expect(r.warnings).toEqual([]);
    expect(r.payload).toEqual({ schemaVersion: 2, title: "Old", description: "x", sections: v1.sections });
  });

  it("migrate() runs the chain and drops the legacy marker", () => {
    const warnings: string[] = [];
    const { json, from } = migrate({ padsync: 1, title: "a" }, warnings);
    expect(from).toBe(1);
    expect(json).toEqual({ schemaVersion: SCHEMA_VERSION, title: "a" });
    expect(Object.keys(MIGRATIONS).map(Number)).toEqual([1]);
    expect(migrate({ padsync: "1", title: "a" }, []).from).toBe(1);
  });

  it("warns and reads a file with no version as the current one", () => {
    const r = parsePayloadValue({ title: "T", sections: [{ blocks: [] }] });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatch(/no schemaVersion/);
  });

  it("reads a newer version best-effort, with a warning", () => {
    const r = parsePayloadValue({ schemaVersion: 7, title: "T", sections: [{ blocks: [{ type: "markdown", text: "x" }, { type: "hologram", text: "fancy" }] }] });
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/newer padSync \(schemaVersion 7\)/);
    expect(r.payload!.sections[0].blocks[1]).toEqual({ type: "markdown", text: "fancy" });
  });
});

describe("unknown fields and tolerated AI output", () => {
  it("drops unknown fields with a warning naming the path", () => {
    const r = parsePayloadValue(v2([{ title: "Q1", blocks: [{ type: "markdown", text: "x", colour: "red" }], difficulty: 3 }], { author: "AI" }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining([`(root): unknown field "author" ignored.`, `sections[0] "Q1": unknown field "difficulty" ignored.`, `sections[0] "Q1" › blocks[0] (markdown): unknown field "colour" ignored.`]));
    expect(r.payload!.sections[0]).not.toHaveProperty("difficulty");
    expect(r.payload!.sections[0].blocks[0]).toEqual({ type: "markdown", text: "x" });
  });

  it("keeps the text of an unknown block type as markdown, and drops one with no text", () => {
    const r = one([{ type: "timeline", content: "1900: x" }, { type: "widget", spin: true }, { type: "markdown", text: "kept" }]);
    expect(r.payload!.sections[0].blocks).toEqual([{ type: "markdown", text: "1900: x" }, { type: "markdown", text: "kept" }]);
    expect(r.warnings.join("\n")).toMatch(/"timeline"; kept its text/);
    expect(r.warnings.join("\n")).toMatch(/"widget" with no text; left out/);
  });

  it("maps common spellings onto the schema", () => {
    const r = one([
      "a bare string",
      { type: "Text", content: "md" },
      { type: "math", text: "x^2" },
      { type: "fill-in-the-blank", text: "{{a}} b" },
      { type: "worked_example", steps: ["one", "two"] },
      { type: "concept-map", nodes: ["A", "B"], edges: [{ from: "A", to: "B" }] },
      { type: "definition", title: "Limit", text: "…" },
      { type: "callout", style: "Key Idea", text: "k" },
      { type: "callout", style: "lemma", text: "l" },
      { type: "space", size: "large" },
      { type: "space", size: "300px" },
      { type: "space", lines: 4 },
      { type: "recall", items: ["Q1?", { question: "Q2?", answer: "A2" }] },
      { type: "glossary", terms: { limit: "approach", derivative: "slope" } },
      { type: "hr" },
      { type: "image", src: "https://x.test/a.png", width: 50 },
    ]);
    expect(r.errors).toEqual([]);
    const b = r.payload!.sections[0].blocks;
    expect(b[0]).toEqual({ type: "markdown", text: "a bare string" });
    expect(b[1]).toEqual({ type: "markdown", text: "md" });
    expect(b[2]).toEqual({ type: "markdown", text: "$$x^2$$" });
    expect(b[3]).toMatchObject({ type: "cloze" });
    expect(b[4]).toEqual({ type: "steps", style: "worked-example", steps: [{ text: "one" }, { text: "two" }] });
    expect(b[5]).toEqual({ type: "conceptMap", nodes: [{ id: "A", label: "A" }, { id: "B", label: "B" }], links: [{ from: "A", to: "B" }] });
    expect(b[6]).toEqual({ type: "callout", style: "definition", title: "Limit", text: "…" });
    expect(b[7]).toMatchObject({ style: "key-idea" });
    expect(b[8]).toMatchObject({ style: "theorem" });
    expect(b[9]).toEqual({ type: "space", size: "l" });
    expect(b[10]).toEqual({ type: "space", size: 300 });
    expect(b[11]).toEqual({ type: "space", size: 240 });
    expect(b[12]).toEqual({ type: "recall", items: [{ q: "Q1?" }, { q: "Q2?", a: "A2" }] });
    expect(b[13]).toEqual({ type: "glossary", terms: [{ term: "limit", definition: "approach" }, { term: "derivative", definition: "slope" }] });
    expect(b[14]).toEqual({ type: "divider" });
    expect(b[15]).toMatchObject({ width: 0.5 });
  });

  it("clamps out-of-range sizes and maps an unknown callout style to a note, with warnings", () => {
    const r = one([{ type: "space", size: 99999 }, { type: "space", size: 3 }, { type: "callout", style: "spooky", text: "x" }]);
    expect(r.payload!.sections[0].blocks).toEqual([{ type: "space", size: 4000 }, { type: "space", size: 40 }, { type: "callout", style: "note", text: "x" }]);
    expect(r.warnings).toHaveLength(3);
  });

  it("uses a section's text when it has no blocks, and a name when there is no title", () => {
    const r = parsePayloadValue({ schemaVersion: 2, name: "From name", sections: [{ title: "S", text: "just text" }] });
    expect(r.payload!.title).toBe("From name");
    expect(r.payload!.sections[0].blocks).toEqual([{ type: "markdown", text: "just text" }]);
  });
});

describe("invalid payloads: clear errors at the path", () => {
  it("reports per section and keeps the valid ones", () => {
    const r = parsePayloadValue(v2([{ title: "Good", blocks: [{ type: "markdown", text: "ok" }] }, { title: "Q4", blocks: [{ type: "markdown", text: "a" }, { type: "cloze", text: "no blanks here" }] }, { blocks: [{ type: "recall", items: [] }] }]));
    expect(r.ok).toBe(true);
    expect(r.payload!.sections.map((s) => s.title)).toEqual(["Good"]);
    expect(r.sections.map((s) => s.ok)).toEqual([true, false, false]);
    expect(r.errors).toEqual([`sections[1] "Q4" › blocks[1] (cloze) › text: needs at least one {{blank}}`, `sections[2] "Section 3" › blocks[0] (recall) › items: needs at least 1 item`]);
  });

  it("names missing and mistyped fields", () => {
    expect(one([{ type: "markdown" }]).errors).toEqual(["No section could be imported.", `sections[0] "S" › blocks[0] (markdown) › text: required (string)`]);
    expect(one([{ type: "steps", steps: [{ text: 3 }] }]).errors[1]).toBe(`sections[0] "S" › blocks[0] (steps) › steps[0] › text: expected string, got number`);
    expect(one([], { template: "hexagons" }).errors[1]).toMatch(/template: must be one of "plain", "dots", "grid", "lines"/);
    expect(one([], { margin: { width: 0.9 } }).errors[1]).toBe(`sections[0] "S" › margin › width: must be at most 0.45`);
    expect(one([{ type: "image", src: "javascript:alert(1)" }]).errors[1]).toMatch(/src: must be an https:\/\/ URL/);
    expect(one([{ type: "image", src: "../../etc/passwd" }]).ok).toBe(false);
  });

  it("checks concept map links point at nodes", () => {
    const r = one([{ type: "conceptMap", nodes: [{ id: "a", label: "A" }], links: [{ from: "a", to: "zz" }] }]);
    expect(r.errors[1]).toBe(`sections[0] "S" › blocks[0] (conceptMap) › links[0] › to: no node with id "zz"`);
  });

  it("rejects a bad head as a whole", () => {
    expect(parsePayloadValue({ schemaVersion: 2, sections: [] }).errors).toEqual(["title: required (string)", "sections: needs at least 1 item"]);
    expect(parsePayloadValue([{ title: "x" }]).errors[0]).toMatch(/got an array/);
    expect(parsePayloadValue(null).errors[0]).toMatch(/got null/);
    expect(parsePayloadValue(v2(["not an object"])).errors[1]).toMatch(/sections\[0\] "Section 1": expected an object, got string/);
  });

  it("explains malformed JSON with the line and a LaTeX hint", () => {
    const r = parsePayloadText('{\n "schemaVersion": 2,\n "title": "x",\n "sections": [{"blocks": [{"type": "markdown", "text": "$\\int$"}]}]\n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Not valid JSON \(line 4\)/);
    expect(r.errors[0]).toMatch(/backslashes must be doubled/);
    expect(parsePayloadText('{"title": "x", "sections": [').errors[0]).toMatch(/Not valid JSON/);
    expect(parsePayloadText("").errors[0]).toMatch(/Nothing to import/);
  });

  it("refuses text over the size limit before parsing", () => {
    expect(parsePayloadText("x".repeat(MAX_PAYLOAD_CHARS + 1)).errors[0]).toMatch(/limit is 8 MB/);
  });
});

describe("extracting JSON from a chat reply", () => {
  const json = JSON.stringify(v2([{ blocks: [] }]));
  it("handles fences, prose and several code blocks", () => {
    expect(extractJson("Here you go:\n```json\n" + json + "\n```\nEnjoy!")).toBe(json);
    expect(extractJson("```bash\nnpm i\n```\nthen\n```\n" + json + "\n```")).toBe(json);
    expect(extractJson("Sure! " + json + " Hope it helps")).toBe(json);
    expect(extractJson("﻿" + json)).toBe(json);
    expect(parsePayloadText("Sure:\n```JSON\n" + json + "\n```").ok).toBe(true);
  });
});
