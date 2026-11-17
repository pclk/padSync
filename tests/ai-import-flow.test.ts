import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, PRESETS, chatPrompt, importInlineFiles, importJobBody, payloadHash, pickResult, reviewPayload, selectSections, splitParts, stage, uploadSpecs, type FlowState } from "@/lib/ai-import";
import { attachmentPaths, checkLimits, classify, move, needsCode, safePath } from "@/lib/attachments";
import { BUNDLE_PATH_RE, PPTX_MIME } from "@/lib/context";
import { addFiles, clearAttachments, drafts, getDraft, listAttachments, removeAttachment, reorderAttachments, setDraft } from "@/lib/import-drafts";
import { GOALS } from "@/lib/payload";
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, PART_CHARS, partsFor } from "@/lib/uploads";
import { newJobSchema } from "@/server/jobs";

// The merged AI import tab without a browser: stage logic, request building, picking the
// bridge's result, review with partial selection, and attachment handling (names, limits, order,
// persistence).

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const payload = (sections: unknown[]) => JSON.stringify({ schemaVersion: 2, title: "T", sections });

describe("stage of the merged flow", () => {
  const base: FlowState = { attachments: 0, sending: false, job: null, raw: "", imported: false };
  it("moves attach → configure → sending → waiting → review → imported", () => {
    expect(stage(base)).toBe("attach");
    expect(stage({ ...base, attachments: 2 })).toBe("configure");
    expect(stage({ ...base, attachments: 2, sending: true })).toBe("sending");
    expect(stage({ ...base, attachments: 2, job: { status: "uploading" } })).toBe("sending");
    expect(stage({ ...base, attachments: 2, job: { status: "queued" } })).toBe("waiting");
    expect(stage({ ...base, attachments: 2, job: { status: "running" } })).toBe("waiting");
    expect(stage({ ...base, attachments: 2, job: { status: "done" }, raw: "{}" })).toBe("review");
    expect(stage({ ...base, attachments: 2, job: { status: "done" }, raw: "{}", imported: true })).toBe("imported");
  });
  it("lets the manual paste path review without attachments or a bridge", () => {
    expect(stage({ ...base, raw: payload([]) })).toBe("review");
    expect(stage({ ...base, job: { status: "error" }, raw: "x" })).toBe("review");
    expect(stage({ ...base, attachments: 1, job: { status: "cancelled" } })).toBe("configure");
  });
});

describe("request building", () => {
  const atts = [
    { name: "Lecture 9 – Integration (final).pdf", mime: "application/pdf" as const, kind: "pdf" as const },
    { name: "../../etc/passwd`\nrm -rf.png", mime: "image/png" as const, kind: "image" as const },
  ];

  it("writes INSTRUCTIONS.md and request.md; the user's names never become paths", () => {
    const files = importInlineFiles({ request: "Focus on IBP", goals: ["skeleton", "recall"] }, atts);
    expect(files.map((f) => f.path)).toEqual(["INSTRUCTIONS.md", "request.md"]);
    const request = files[1].text!;
    expect(request).toContain("Focus on IBP");
    expect(request).toContain("- Note skeleton with blanks");
    expect(request).toContain("`lectures/01-lecture-9-integration-final.pdf`: Lecture 9 – Integration (final).pdf (pdf)");
    expect(request).toContain("`lectures/02-etc-passwd-rm-rf.png`");
    expect(request).not.toMatch(/`\n/); // the backtick/newline in the name can't break out of the list
    expect(files[0].text).toMatch(/Write it to the file named in your instructions/);
    for (const p of attachmentPaths(atts)) expect(BUNDLE_PATH_RE.test(p)).toBe(true);
  });

  it("builds a job body the server accepts", () => {
    const files = importInlineFiles(DEFAULT_CONFIG, atts);
    const uploads = uploadSpecs(attachmentPaths(atts).map((path, i) => ({ path, mime: atts[i].mime, base64: PNG })));
    const body = importJobBody({ ...DEFAULT_CONFIG, model: "opus", effort: "high", allowCode: true }, files, uploads);
    const parsed = newJobSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ kind: "import", notebookId: "", options: { model: "opus", effort: "high", allowEdits: true, allowCode: true } });
    expect(body.question.length).toBeGreaterThan(10); // a default request when the box is empty
  });

  it("splits base64 into parts that rejoin exactly", () => {
    const s = "A".repeat(PART_CHARS * 2 + 8);
    const parts = splitParts(s);
    expect(parts.map((p) => p.length)).toEqual([PART_CHARS, PART_CHARS, 8]);
    expect(parts.join("")).toBe(s);
    expect(partsFor(s.length)).toBe(3);
    expect(PART_CHARS % 4).toBe(0);
  });

  it("gives a chat prompt with the schema and the file names, for the no-bridge path", () => {
    const p = chatPrompt({ request: "x", goals: ["practice"] }, atts);
    expect(p).toContain('"schemaVersion": 2');
    expect(p).toContain("1. Lecture 9 – Integration (final).pdf");
    expect(p).toMatch(/Reply with only the JSON/);
  });

  it("presets only use known goals", () => {
    const ids = new Set(GOALS.map((g) => g.id));
    for (const p of PRESETS) for (const g of p.goals) expect(ids.has(g)).toBe(true);
  });
});

describe("the bridge's result", () => {
  const good = payload([{ title: "A", blocks: [{ type: "markdown", text: "x" }] }]);
  it("prefers out/padsync.json, then any JSON with sections, then the answer text", () => {
    expect(pickResult({ output: "summary", resultFiles: [{ path: "notes.md", mime: "text/markdown", text: "# x" }, { path: "padsync.json", mime: "application/json", text: good }] })).toEqual({ text: good, from: "padsync.json" });
    expect(pickResult({ output: "summary", resultFiles: [{ path: "result.json", mime: "application/json", text: good }] })!.from).toBe("result.json");
    expect(pickResult({ output: "Here:\n```json\n" + good + "\n```" })!.from).toBe("the answer text");
    expect(pickResult({ output: "I could not read the PDF." })).toBeNull();
  });

  it("resolves figures the agent returned; an unresolvable one excludes only its section", () => {
    const raw = payload([
      { title: "With figure", blocks: [{ type: "image", src: "figures/graph.png" }] },
      { title: "Broken", blocks: [{ type: "image", src: "figures/missing.png" }] },
      { title: "Plain", blocks: [{ type: "markdown", text: "ok" }] },
    ]);
    const r = reviewPayload(raw, [{ path: "figures/graph.png", mime: "image/png", base64: PNG }]);
    expect(r.ok).toBe(true);
    expect(r.sections.map((s) => s.ok)).toEqual([true, false, true]);
    expect(r.payload!.sections[0].blocks[0]).toMatchObject({ src: `data:image/png;base64,${PNG}` });
    expect(r.errors).toEqual([`sections[1] "Broken" › blocks[0] (image) › src: "figures/missing.png" is not a file the AI returned`]);
    expect(reviewPayload(raw).errors[0]).toMatch(/use an https:\/\/ or data:image\/ URL when pasting/);
  });

  it("imports only the ticked valid sections", () => {
    const r = reviewPayload(payload([{ title: "A", blocks: [] }, { title: "B", blocks: [{ type: "markdown" }] }, { title: "C", blocks: [] }]));
    expect(selectSections(r, new Set([0, 1, 2]))!.sections.map((s) => s.title)).toEqual(["A", "C"]);
    expect(selectSections(r, new Set([2]))!.sections.map((s) => s.title)).toEqual(["C"]);
    expect(selectSections(r, new Set())).toBeNull();
    expect(payloadHash(selectSections(r, new Set([0]))!)).not.toBe(payloadHash(selectSections(r, new Set([0, 2]))!));
  });

  it("reports malformed AI output without throwing", () => {
    for (const raw of ["", "not json at all", "{", "[]", "null", '{"title": 3}', "```json\n{]\n```"]) {
      const r = reviewPayload(raw);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("attachments", () => {
  it("classifies what the agents can read, and converts or refuses the rest", () => {
    expect(classify("a.PDF")).toMatchObject({ mime: "application/pdf", kind: "pdf" });
    expect(classify("slides.pptx")).toMatchObject({ mime: PPTX_MIME, kind: "slides" });
    expect(classify("notes.md")).toMatchObject({ mime: "text/markdown", kind: "text" });
    expect(classify("x.tex")).toMatchObject({ mime: "text/plain" });
    expect(classify("IMG_1.HEIC")).toEqual({ mime: "image/jpeg", kind: "image", convert: true });
    expect(classify("photo", "image/avif")).toMatchObject({ convert: true });
    expect(classify("deck.key")).toMatchObject({ error: expect.stringMatching(/export it as PDF/) });
    expect(classify("virus.exe")).toMatchObject({ error: expect.stringMatching(/unsupported/) });
  });

  it("makes safe, unique, ordered paths from any file name", () => {
    const names = ["../../etc/passwd.pdf", ".hidden.pdf", "日本語の講義.pdf", "a".repeat(300) + ".pdf", "same.pdf", "same.pdf", "CON.pdf", "with spaces & symbols!.pdf"];
    const paths = attachmentPaths(names.map((name) => ({ name, mime: "application/pdf" as const })));
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) {
      expect(BUNDLE_PATH_RE.test(p)).toBe(true);
      expect(p).toMatch(/^lectures\/\d\d-[a-z0-9-]+\.pdf$/);
    }
    expect(paths[2]).toBe("lectures/03-file.pdf"); // no ASCII left: a fallback name
    expect(safePath("x.png", 11, "image/jpeg")).toBe("lectures/12-x.jpg"); // extension follows the real type
  });

  it("checks count, per-file and total limits", () => {
    expect(checkLimits([{ name: "a", size: 10 }])).toEqual([]);
    expect(checkLimits([{ name: "big.pdf", size: MAX_FILE_BYTES + 1 }])[0]).toMatch(/big\.pdf is 25\.0 MB; the limit is 25\.0 MB/);
    expect(checkLimits(Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, size: MAX_TOTAL_BYTES / 2 })))).toEqual([expect.stringMatching(/add up to 60\.0 MB/)]);
    expect(checkLimits(Array.from({ length: 21 }, () => ({ name: "x", size: 1 })))[0]).toMatch(/At most 20 files/);
  });

  it("reorders without losing items and ignores bad indexes", () => {
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const same = ["a"];
    expect(move(same, 0, 5)).toBe(same);
    expect(needsCode([{ kind: "pdf" }, { kind: "slides" }])).toBe(true);
  });
});

describe("attachment drafts survive leaving the page", () => {
  beforeEach(async () => {
    await clearAttachments();
    await drafts.kv.clear();
  });
  const file = (name: string, body: string, type = "") => new File([body], name, { type });

  it("adds, reorders and removes, and keeps everything in IndexedDB", async () => {
    const errors = await addFiles([file("b.pdf", "%PDF-1"), file("a.md", "# notes"), file("bad.exe", "MZ"), file("empty.txt", "")]);
    expect(errors).toEqual([expect.stringMatching(/bad\.exe: unsupported/), expect.stringMatching(/empty\.txt: the file is empty/)]);
    let list = await listAttachments();
    expect(list.map((a) => [a.name, a.kind, a.size])).toEqual([["b.pdf", "pdf", 6], ["a.md", "text", 7]]);
    await addFiles([file("c.txt", "more")]);
    list = await listAttachments();
    await reorderAttachments([list[2].id, list[0].id, list[1].id]);
    expect((await listAttachments()).map((a) => a.name)).toEqual(["c.txt", "b.pdf", "a.md"]);
    await removeAttachment(list[0].id);
    const after = await listAttachments();
    expect(after.map((a) => a.name)).toEqual(["c.txt", "a.md"]);
    expect(await after[0].blob.text()).toBe("more");
  });

  it("stores the JSON under review and forgets empty values", async () => {
    await setDraft("raw", "{…}");
    expect(await getDraft("raw")).toBe("{…}");
    await setDraft("raw", "");
    expect(await getDraft("raw")).toBeUndefined();
  });
});
