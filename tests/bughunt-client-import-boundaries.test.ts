import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";
import { parseReturnedNotebook } from "@/lib/roundtrip";

describe("import boundaries", () => {
  it("escapes raw HTML inside link labels", () => {
    expect(renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com)')).not.toContain('<img src=x');
  });
  it("ignores unknown returned section IDs", () => {
    const result = parseReturnedNotebook(JSON.stringify({ sections: [{ id: "deleted-section", blocks: [] }] }), []);
    expect(result.changes).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

it("keeps nested link formatting while rejecting script URLs and trusted TeX commands", () => {
  expect(renderMarkdown("[**bold**](https://example.com)")).toContain("<strong>bold</strong>");
  expect(renderMarkdown("[click](javascript:alert%281%29)")).not.toContain('href="javascript:');
  expect(renderMarkdown("$\\href{javascript:alert(1)}{click}$")).not.toContain('href="javascript:');
});

it("migrates legacy section metadata without dropping content", async () => {
  const { parsePayloadValue } = await import("@/lib/schema");
  const section = { title: "Q", blocks: [{ type: "markdown", text: "😀" }], solution: "answer", marks: 2, timeLimitMinutes: 3, tags: ["tag"], template: "grid" };
  const result = parsePayloadValue({ padsync: 1, title: "Notes", description: "description", sections: [section] });
  expect(result.payload).toMatchObject({ schemaVersion: 2, description: "description", sections: [section] });
});
