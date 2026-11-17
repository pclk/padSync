import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StudyBlock } from "@/components/StudyBlocks";
import { DEFAULT_CONFIG, reviewPayload, selectSections } from "@/lib/ai-import";
import { sendImport } from "@/lib/import-send";
import { parsePayloadText, parsePayloadValue } from "@/lib/schema";
import { createJob, getJob, newJobSchema, putJobInput, cancelJob } from "@/server/jobs";
import { freshDb } from "./helpers/env";

// JSX in the existing Vitest configuration uses the classic React transform.
vi.stubGlobal("React", React);
const payload = (blocks: unknown[]) => ({ schemaVersion: 2, title: "Lecture", sections: [{ blocks }] });

describe("second-opinion AI import regressions", () => {
  it("does not cancel a queued upload when the final PUT response is lost", async () => {
    const { sql, pg } = await freshDb();
    let id = "";
    let lost = false;
    const transport = (async (url: string, init: RequestInit) => {
      if (url === "/api/jobs") {
        const input = newJobSchema.parse(JSON.parse(init.body as string));
        const job = await createJob(sql, input);
        id = job.id;
        return Response.json({ job }, { status: 201 });
      }
      if (url.endsWith("/cancel")) {
        await cancelJob(sql, id);
        return Response.json({});
      }
      const result = await putJobInput(sql, id, JSON.parse(init.body as string));
      if (result.ok && !lost) {
        lost = true;
        throw new TypeError("response lost after server committed final part");
      }
      return Response.json(result, { status: result.ok ? 200 : result.status });
    }) as typeof fetch;
    try {
      const outcome = await sendImport({
        config: DEFAULT_CONFIG,
        attachments: [{ meta: { name: "notes.pdf", kind: "pdf", mime: "application/pdf", size: 3 }, base64: async () => "AAAA" }],
        fetch: transport,
      }).then(() => "sent", () => "failed");
      expect({ outcome, status: (await getJob(sql, id))?.status }).toEqual({ outcome: "sent", status: "queued" });
    } finally {
      await pg.close();
    }
  });

  it("renders literal cloze placeholder notation without crashing", () => {
    const block = { type: "cloze" as const, text: "Compare ⟦42⟧ with {{answer}}." };
    expect(reviewPayload(JSON.stringify(payload([block]))).ok).toBe(true);
    expect(() => renderToStaticMarkup(React.createElement(StudyBlock, { block }))).not.toThrow();
  });

  it("offers a reveal control for blankWhy steps with no optional title or style", () => {
    const block = { type: "steps" as const, blankWhy: true, steps: [{ text: "x = 2", why: "divide both sides" }] };
    expect(reviewPayload(JSON.stringify(payload([block]))).ok).toBe(true);
    const html = renderToStaticMarkup(React.createElement(StudyBlock, { block }));
    expect(html).not.toContain("divide both sides");
    expect(html).toContain("Show reasons");
  });

  it("rejects ambiguous concept maps with duplicate node ids", () => {
    const r = parsePayloadValue(payload([{ type: "conceptMap", nodes: [{ id: "a", label: "First" }, { id: "a", label: "Second" }], links: [{ from: "a", to: "a" }] }]));
    expect(r.ok).toBe(false);
  });

  it("finds the actual payload after an illustrative fenced JSON object", () => {
    const raw = 'Example metadata:\n```json\n{"topic":"algebra"}\n```\nHere is your notebook:\n```json\n' + JSON.stringify(payload([{ type: "markdown", text: "Actual lesson" }])) + '\n```';
    expect(parsePayloadText(raw).ok).toBe(true);
  });

  it("keeps section indexes stable when an unresolved figure invalidates a section", () => {
    const r = reviewPayload(JSON.stringify({ schemaVersion: 2, title: "Lecture", sections: [{ blocks: [{ type: "image", src: "figures/missing.png" }] }, { blocks: [{ type: "markdown", text: "Keep me" }] }] }));
    expect(r.sections.map((s) => [s.index, s.ok])).toEqual([[0, false], [1, true]]);
    expect(selectSections(r, new Set([0]))).toBeNull();
    expect(selectSections(r, new Set([1]))?.sections[0].blocks).toEqual([{ type: "markdown", text: "Keep me" }]);
  });

  it("rejects traversal figure paths without importing the offending section", () => {
    const r = reviewPayload(JSON.stringify(payload([{ type: "image", src: "../secret.png" }])));
    expect(r.ok).toBe(false);
    expect(r.payload).toBeNull();
  });
});
