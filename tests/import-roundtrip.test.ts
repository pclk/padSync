import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { maskAnswers, studyBlockMarkdown } from "@/lib/blocks";
import { DEFAULT_CONTEXT, buildBundle } from "@/lib/context";
import { db } from "@/lib/db";
import { payloadHash } from "@/lib/ai-import";
import { EXAMPLE_PAYLOAD, payloadToSections } from "@/lib/payload";
import { parseReturnedNotebook } from "@/lib/roundtrip";
import { parsePayloadValue, type Block, type Payload } from "@/lib/schema";
import { createNotebook, findImported, liveSections, putEntities } from "@/lib/store";

// Import round trips for each content type: payload → notebook (IndexedDB) → the Ask AI export
// (notebook.json / notebook.md) → parsed again, unchanged. Plus answer masking on the way out.

beforeAll(() => {
  vi.stubGlobal("navigator", { onLine: false }); // keep sync quiet
  vi.stubGlobal("fetch", async () => Response.json({}, { status: 503 }));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await Promise.all([db.entities.clear(), db.events.clear(), db.meta.clear()]);
});

const BLOCKS: Record<string, Block> = {
  markdown: { type: "markdown", text: "**Bold** and $\\int_0^1 x\\,dx$" },
  code: { type: "code", language: "py", code: "print(1)" },
  image: { type: "image", src: "https://example.test/fig.png", alt: "fig", width: 0.4, caption: "Figure 1" },
  space: { type: "space", size: "m" },
  divider: { type: "divider" },
  callout: { type: "callout", style: "theorem", title: "FTC", text: "$F' = f$" },
  steps: { type: "steps", style: "derivation", title: "Derive", problem: "Show it", steps: [{ text: "a", why: "because" }, { text: "b" }], result: "c", blankWhy: true },
  glossary: { type: "glossary", title: "Terms", terms: [{ term: "limit", definition: "value approached", example: "1/n → 0" }], hideDefinitions: true },
  conceptMap: { type: "conceptMap", title: "Map", nodes: [{ id: "d", label: "Derivative", note: "slope" }, { id: "i", label: "Integral" }], links: [{ from: "d", to: "i", label: "inverse of" }] },
  cloze: { type: "cloze", text: "The derivative of $x^2$ is {{$2x$}}; of a constant, {{0}}.", hint: "power rule" },
  recall: { type: "recall", title: "Recall", items: [{ q: "State FTC", a: "$\\int_a^b f = F(b) - F(a)$", space: "s" }, { q: "Why?" }] },
  rewrite: { type: "rewrite", prompt: "Explain it", text: "The integral accumulates.", space: "m" },
  prompt: { type: "prompt", text: "Sketch $y = x^2$", space: "l" },
  checkpoint: { type: "checkpoint", title: "I can", items: ["differentiate", "integrate"], space: "xs" },
};

const payloadOf = (blocks: Block[], section: Partial<Payload["sections"][number]> = {}): Payload => ({ schemaVersion: 2, title: "RT", sections: [{ title: "S", blocks, ...section }] });

async function importAndExport(p: Payload, solutions = true) {
  const parsed = parsePayloadValue(p);
  expect(parsed.errors).toEqual([]);
  const id = await createNotebook(parsed.payload!.title, payloadToSections(parsed.payload!), undefined, { importHash: payloadHash(parsed.payload!), importedAt: 1 });
  const secs = await liveSections(id);
  const bundle = buildBundle({ title: "RT", sections: secs.map((s) => ({ id: s.id, data: s.data, notes: [], lastActivity: 0 })) }, { ...DEFAULT_CONTEXT, renders: false, solutions });
  const json = JSON.parse(bundle.files.find((f) => f.path === "notebook.json")!.text!);
  const md = bundle.files.find((f) => f.path === "notebook.md")!.text!;
  return { id, secs, json, md };
}

describe("round trip per block type", () => {
  for (const [type, block] of Object.entries(BLOCKS)) {
    it(type, async () => {
      const { secs, json } = await importAndExport(payloadOf([block]));
      expect(secs[0].data.blocks).toEqual([block]);
      // The exported notebook.json is itself a valid payload with the same block.
      const again = parsePayloadValue(json);
      expect(again.errors).toEqual([]);
      expect(again.warnings.filter((w) => !/unknown field "id"/.test(w))).toEqual([]);
      expect(again.payload!.sections[0].blocks).toEqual([block]);
    });
  }

  it("keeps section kind, objectives and margin through import and export", async () => {
    const section = { kind: "notes" as const, objectives: ["Know FTC"], margin: { side: "left" as const, width: 0.3, prompts: ["Link to MVT"] } };
    const { secs, json } = await importAndExport(payloadOf([BLOCKS.markdown], section));
    expect(secs[0].data).toMatchObject({ ...section, template: "lines" });
    expect(json.sections[0]).toMatchObject(section);
  });

  it("imports the full example and its export re-imports to the same sections", async () => {
    const { secs, json } = await importAndExport(EXAMPLE_PAYLOAD);
    expect(secs.map((s) => s.data.title)).toEqual(EXAMPLE_PAYLOAD.sections.map((s) => s.title));
    const again = parsePayloadValue(json);
    expect(again.payload!.sections.map((s) => s.blocks)).toEqual(EXAMPLE_PAYLOAD.sections.map((s) => s.blocks));
  });

  it("migrates a v1 file on import", async () => {
    const parsed = parsePayloadValue({ padsync: 1, title: "Old", sections: [{ title: "Q1", blocks: [{ type: "markdown", text: "x" }, { type: "space", size: "l" }], solution: "s", marks: 2 }] });
    const id = await createNotebook(parsed.payload!.title, payloadToSections(parsed.payload!));
    const [s] = await liveSections(id);
    expect(s.data).toMatchObject({ title: "Q1", solution: "s", marks: 2, template: "plain" });
  });
});

describe("hidden answers on the way out", () => {
  it("writes answers to notebook.md only when solutions are included", async () => {
    const blocks = [BLOCKS.cloze, BLOCKS.recall, BLOCKS.steps, BLOCKS.glossary];
    const withAns = await importAndExport(payloadOf(blocks), true);
    expect(withAns.md).toContain("[blank, hidden from student: $2x$]");
    expect(withAns.md).toContain("Answer (hidden from student)");
    expect(withAns.md).toContain("why, hidden from student: because");
    expect(withAns.md).toContain("value approached");
    const without = await importAndExport(payloadOf(blocks), false);
    for (const secret of ["$2x$", "F(b) - F(a)", "because", "value approached"]) {
      expect(without.md).not.toContain(secret);
      expect(JSON.stringify(without.json)).not.toContain(secret);
    }
    expect(without.json.sections[0].blocks).toEqual(blocks.map(maskAnswers));
  });

  it("a masked block returned unchanged keeps its real answers; an edited one is a change", async () => {
    const { secs, json } = await importAndExport(payloadOf([BLOCKS.cloze, BLOCKS.markdown]), false);
    const current = secs.map((s) => ({ id: s.id, data: s.data }));
    expect(parseReturnedNotebook(JSON.stringify(json), current).changes).toEqual([]);
    json.sections[0].blocks[1] = { type: "markdown", text: "edited" };
    const { changes } = parseReturnedNotebook(JSON.stringify(json), current);
    expect(changes).toHaveLength(1);
    const patch = changes[0].kind === "update" ? changes[0].patch : null;
    expect(patch!.blocks![0]).toEqual(BLOCKS.cloze); // answers restored, not "…"
    expect(patch!.blocks![1]).toEqual({ type: "markdown", text: "edited" });
  });

  it("describes every study block in Markdown", () => {
    for (const b of Object.values(BLOCKS)) if (!["markdown", "code", "image", "space", "divider"].includes(b.type)) expect(studyBlockMarkdown(b, false)).toBeTruthy();
    expect(studyBlockMarkdown(BLOCKS.cloze, false)).toBe("The derivative of $x^2$ is ____; of a constant, ____.\n_Hint: power rule_");
    expect(studyBlockMarkdown(BLOCKS.conceptMap, false)).toContain("Derivative → inverse of → Integral");
  });
});

describe("duplicate imports", () => {
  it("finds notebooks made from the same payload, but not deleted ones", async () => {
    const p = parsePayloadValue(EXAMPLE_PAYLOAD).payload!;
    const hash = payloadHash(p);
    expect(await findImported(hash)).toEqual([]);
    const id = await createNotebook(p.title, payloadToSections(p), undefined, { importHash: hash, importedAt: 1 });
    expect((await findImported(hash)).map((n) => n.id)).toEqual([id]);
    expect(payloadHash({ ...p, title: "other" })).not.toBe(hash);
    const nb = await db.entities.get(id);
    await putEntities([{ ...nb!, deleted: 1 }]);
    expect(await findImported(hash)).toEqual([]);
  });

  it("creates the notebook and all its sections in one write", async () => {
    const spy = vi.spyOn(db.entities, "bulkPut");
    await createNotebook("x", payloadToSections(EXAMPLE_PAYLOAD));
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as unknown[]).length).toBe(1 + EXAMPLE_PAYLOAD.sections.length);
    spy.mockRestore();
  });
});
