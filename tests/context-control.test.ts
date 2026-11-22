import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RESULT_BYTES,
  MAX_RESULT_FILES,
  agentCommand,
  attachedImages,
  buildBundlePrompt,
  inlineTexts,
  INLINE_TEXT_CHARS,
  collectOutFiles,
  prepareJobDir,
  removeJobDir,
  safeJoin,
  withJobDir,
} from "../bridge/lib.ts";
import { POST as bridgeUpdate } from "@/app/api/bridge/jobs/[id]/route";
import { GET as getJobRoute } from "@/app/api/jobs/[id]/route";
import { GET as listJobsRoute, POST as createJobRoute } from "@/app/api/jobs/route";
import {
  BUNDLE_PATH_RE,
  DEFAULT_CONTEXT,
  MAX_BUNDLE_BYTES,
  RECENT_MS,
  assetPath,
  contentHash,
  imageRef,
  buildBundle,
  bundleSignature,
  jobRequestBody,
  pickSections,
  slug,
  type Bundle,
  type ContextOptions,
  type SectionInput,
} from "@/lib/context";
import { applyPatch, parseReturnedNotebook } from "@/lib/roundtrip";
import { claimJob, newJobSchema } from "@/server/jobs";
import { createDeviceToken } from "@/server/tokens";
import { PNG_DATA_URL, configureAuthEnv, freshDb, params, req, sessionCookie } from "./helpers/env";
import type { SectionData } from "@/lib/types";

const PNG_B64 = PNG_DATA_URL.split(",")[1];
const IMG = `assets/s2-${contentHash(PNG_DATA_URL)}.png`;
const NOW = 1_800_000_000_000;

function section(id: string, d: Partial<SectionData> = {}, extra: Partial<SectionInput> = {}): SectionInput {
  return {
    id,
    data: { order: 1, blocks: [], template: "plain", minHeight: 500, createdAt: 0, ...d },
    notes: [],
    lastActivity: NOW - 1000,
    render: { base64: PNG_B64, width: 1376, height: 800 },
    ...extra,
  };
}

const nb = (): SectionInput[] => [
  section("s1", { title: "Key idea", blocks: [{ type: "markdown", text: "**IBP** $\\int u\\,dv$" }] }),
  section(
    "s2",
    { title: "Q1", marks: 3, tags: ["ibp"], timeLimitMinutes: 5, solution: "SECRET-SOLUTION", blocks: [{ type: "markdown", text: "Evaluate $\\int x e^x dx$" }, { type: "image", src: PNG_DATA_URL, alt: "graph" }, { type: "space", size: "l" }] },
    { notes: ["my typed note"], lastActivity: NOW - 2 * RECENT_MS },
  ),
  section("s3", { title: "Q2", blocks: [{ type: "code", language: "py", code: "print(1)" }] }),
];

const opts = (o: Partial<ContextOptions> = {}): ContextOptions => ({ ...DEFAULT_CONTEXT, ...o });
const file = (b: Bundle, path: string) => b.files.find((f) => f.path === path);
const build = (o: Partial<ContextOptions> = {}, sections = nb(), extra: { selection?: never; maxBytes?: number } = {}) => buildBundle({ title: "MA1521", sections, now: NOW, ...extra }, opts(o));

describe("defaults", () => {
  it("sends the whole notebook with renders, notes, solutions and images, edits on, code off", () => {
    expect(DEFAULT_CONTEXT).toMatchObject({ scope: "all", recentOnly: false, renders: true, notes: true, solutions: true, images: true, allowEdits: true, allowCode: false });
    const b = build();
    expect(b.error).toBeUndefined();
    expect(b.sectionIds).toEqual(["s1", "s2", "s3"]);
    expect(b.files.map((f) => f.path)).toEqual(["README.md", "notebook.md", "notebook.json", IMG, "renders/01-key-idea.png", "renders/02-q1.png", "renders/03-q2.png"]);
    const md = file(b, "notebook.md")!.text!;
    for (const s of ["## 1. Key idea", "## 2. Q1 [3 marks]", "## 3. Q2", "my typed note", "SECRET-SOLUTION", "```py\nprint(1)\n```", `![graph](${IMG})`, "](renders/02-q1.png)", "tags: ibp", "time limit: 5 min"]) expect(md).toContain(s);
    expect(b.skipped).toEqual([]);
  });

  it("keeps Markdown and LaTeX source exactly, and notebook.json in the import format with ids", () => {
    const b = build();
    expect(file(b, "notebook.md")!.text).toContain("**IBP** $\\int u\\,dv$");
    const json = JSON.parse(file(b, "notebook.json")!.text!);
    // The current import schema (v2), so a returned copy also imports as a new notebook.
    expect(json.schemaVersion).toBe(2);
    expect(json.padsync).toBeUndefined();
    expect(json.sections.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(json.sections[1]).toMatchObject({ title: "Q1", marks: 3, solution: "SECRET-SOLUTION", tags: ["ibp"], timeLimitMinutes: 5 });
    // The embedded image is a file, not a data URL repeated inside the JSON.
    expect(json.sections[1].blocks[1].src).toBe(IMG);
    expect(file(b, "notebook.json")!.text).not.toContain("base64");
  });
});

describe("section filtering", () => {
  it("includes only the ticked sections and keeps the notebook's numbering", () => {
    const b = build({ scope: "sections", sectionIds: ["s3", "s1"] });
    expect(b.sectionIds).toEqual(["s1", "s3"]); // notebook order, not tick order
    const md = file(b, "notebook.md")!.text!;
    expect(md).toContain("## 1. Key idea");
    expect(md).toContain("## 3. Q2");
    expect(md).not.toContain("Q1");
    expect(md).not.toContain("SECRET");
    expect(b.files.map((f) => f.path)).not.toContain("renders/02-q1.png");
    expect(JSON.parse(file(b, "notebook.json")!.text!).sections).toHaveLength(2);
  });

  it("errors on an empty pick and ignores ids that no longer exist", () => {
    expect(build({ scope: "sections", sectionIds: [] }).error).toMatch(/No sections/);
    expect(build({ scope: "sections", sectionIds: ["gone"] }).files).toEqual([]);
    expect(build({ scope: "sections", sectionIds: ["gone", "s3"] }).sectionIds).toEqual(["s3"]);
  });

  it("recent only drops sections untouched for a day", () => {
    expect(pickSections(nb(), opts({ recentOnly: true }), null, NOW).map((s) => s.id)).toEqual(["s1", "s3"]);
    const old = nb().map((s) => ({ ...s, lastActivity: 0 }));
    expect(build({ recentOnly: true }, old).error).toMatch(/last 24 hours/);
  });

  it("content toggles remove notes, solutions, images and renders", () => {
    const b = build({ notes: false, solutions: false, images: false, renders: false });
    const md = file(b, "notebook.md")!.text!;
    expect(md).not.toContain("my typed note");
    expect(md).not.toContain("SECRET");
    expect(md).toContain("[image: graph]");
    expect(file(b, "notebook.json")!.text).not.toContain("SECRET");
    expect(b.files.map((f) => f.path)).toEqual(["README.md", "notebook.md", "notebook.json"]);
    expect(file(b, "README.md")!.text).not.toContain("renders/");
  });

  it("README describes the return path only when edits are allowed", () => {
    expect(file(build(), "README.md")!.text).toContain("out/notebook.json");
    expect(file(build({ allowEdits: false }), "README.md")!.text).not.toContain("out/");
  });
});

describe("selection", () => {
  const sel = (s: object) => buildBundle({ title: "NB", sections: nb(), selection: s as never, now: NOW }, opts({ scope: "selection" }));

  it("sends only the highlighted text, not the notebook", () => {
    const b = sel({ sectionId: "s2", text: "  Evaluate $\\int x e^x dx$ " });
    expect(b.files.map((f) => f.path)).toEqual(["README.md", "selection.md"]);
    const md = file(b, "selection.md")!.text!;
    expect(md).toContain("section 2: Q1");
    expect(md).toContain("Evaluate $\\int x e^x dx$");
    expect(md).not.toContain("SECRET");
    expect(JSON.stringify(b.files)).not.toContain("SECRET");
    expect(b.sectionIds).toEqual(["s2"]);
  });

  it("adds the lasso crop as selection.png", () => {
    const b = sel({ sectionId: "s1", crop: { base64: PNG_B64, width: 300, height: 200 } });
    expect(b.files.map((f) => f.path)).toEqual(["README.md", "selection.md", "selection.png"]);
    expect(file(b, "selection.md")!.text).toContain("](selection.png)");
  });

  it("refuses an empty or whitespace-only selection", () => {
    expect(sel({ sectionId: "s1", text: "   \n" }).error).toMatch(/Nothing is selected/);
    expect(buildBundle({ title: "NB", sections: nb(), selection: null }, opts({ scope: "selection" })).error).toMatch(/Nothing is selected/);
  });

  it("refuses a selection whose section was deleted", () => {
    expect(sel({ sectionId: "deleted", text: "x" }).error).toBeTruthy();
  });
});

describe("size limits and file names", () => {
  it("drops renders from the end when over the limit and says so", () => {
    const big = "A".repeat(400_000);
    const sections = nb().map((s) => ({ ...s, render: { base64: big, width: 1376, height: 900 } }));
    const b = build({}, sections, { maxBytes: 1_000_000 });
    expect(b.error).toBeUndefined();
    expect(b.bytes).toBeLessThanOrEqual(1_000_000);
    expect(b.files.map((f) => f.path)).toContain("renders/01-key-idea.png");
    expect(b.files.map((f) => f.path)).not.toContain("renders/03-q2.png");
    expect(b.skipped).toContain("render of section 3 (size limit)");
    // Dropped renders are not referenced in the text either.
    expect(file(b, "notebook.md")!.text).not.toContain("renders/03-q2.png");
  });

  it("refuses when the text alone is too big", () => {
    const huge = [section("s1", { blocks: [{ type: "markdown", text: "x".repeat(200_000) }] })];
    expect(build({}, huge, { maxBytes: 100_000 }).error).toMatch(/Choose fewer sections/);
  });

  it("the default limit fits under Vercel's 4.5 MB body with the rest of the request", () => {
    expect(MAX_BUNDLE_BYTES + 4000 * 3 + 10_000).toBeLessThan(4_500_000);
  });

  it("counts multi-byte text as bytes, not characters", () => {
    const cjk = [section("s1", { blocks: [{ type: "markdown", text: "積分".repeat(50_000) }] }, { render: null })];
    const b = build({ renders: false }, cjk, { maxBytes: 250_000 });
    expect(b.error).toMatch(/Choose fewer/); // 100k chars but 300 KB of UTF-8
  });

  it("slugs hostile titles into safe paths", () => {
    const titles = ["../../etc/passwd", ".hidden", "Q1/../../x", "日本語", "", "a".repeat(300), "CON", "q\u0000z"];
    const b = build({}, titles.map((t, i) => section(`s${i}`, { title: t })));
    for (const f of b.files) expect(f.path, f.path).toMatch(BUNDLE_PATH_RE);
    expect(b.files.map((f) => f.path)).toContain("renders/04-section.png");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
  });

  it("only data images with a safe section id become assets", () => {
    expect(assetPath("s1", "data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(assetPath("../x", PNG_DATA_URL)).toBeNull();
    expect(assetPath("s1", "data:image/jpeg;base64,AAAA")).toMatch(/^assets\/s1-[a-z0-9]+\.jpg$/);
    expect(assetPath("s1", "https://x.test/a.png")).toBeNull(); // remote: a reference, never a file
    expect(imageRef("s1", "https://x.test/a.png")).toMatch(/\.url$/);
    // Content-addressed: a different image gets a different name.
    expect(assetPath("s1", PNG_DATA_URL)).not.toBe(assetPath("s1", "data:image/png;base64,AAAA"));
  });
});

describe("preview matches what is sent and written", () => {
  it("the request carries the bundle's files unchanged, and the server accepts them", () => {
    const b = build();
    const body = jobRequestBody({ notebookId: "nb", sectionId: "s1", agent: "claude", question: "Q?", options: { model: "opus" } }, b, opts());
    expect(body.files).toBe(b.files);
    expect(body.options).toEqual({ model: "opus", allowEdits: true });
    const parsed = newJobSchema.parse(JSON.parse(JSON.stringify(body)));
    expect(parsed.files).toEqual(b.files);
    expect(jobRequestBody({ notebookId: "nb", sectionId: null, agent: "codex", question: "Q", options: {} }, b, opts({ allowEdits: false, allowCode: true })).options).toEqual({});
  });

  it("the bridge writes exactly the previewed bytes into the job dir", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "padsync-ctx-")));
    const b = build();
    const d = await prepareJobDir({ image: null, context: "", files: b.files }, root);
    for (const f of b.files) {
      const disk = await readFile(join(d.dir, f.path));
      expect(f.base64 != null ? disk.equals(Buffer.from(f.base64, "base64")) : disk.toString("utf8") === f.text, f.path).toBe(true);
    }
    expect((await readdir(join(d.dir, "out"))).length).toBe(0);
    await removeJobDir(d.dir);
    expect(await readdir(root)).toEqual([]);
  });

  it("the signature changes with options, activity and selection", () => {
    const s = nb();
    const base = bundleSignature("T", s, null, opts());
    expect(bundleSignature("T", s, null, opts())).toBe(base);
    expect(bundleSignature("T", s, null, opts({ notes: false }))).not.toBe(base);
    expect(bundleSignature("T", [{ ...s[0], lastActivity: s[0].lastActivity + 1 }, ...s.slice(1)], null, opts())).not.toBe(base);
    expect(bundleSignature("T", s, ["s1", "text", null], opts())).not.toBe(base);
  });
});

describe("returned notebook.json", () => {
  const current = nb().map(({ id, data }) => ({ id, data }));
  const exported = () => JSON.parse(file(build(), "notebook.json")!.text!);

  it("an untouched round trip has no changes (asset paths map back to the original images)", () => {
    expect(parseReturnedNotebook(JSON.stringify(exported()), current)).toEqual({ changes: [], problems: [] });
  });

  it("reports only changed fields and keeps fields that were left out", () => {
    const j = exported();
    j.sections[1].title = "Q1 (revised)";
    delete j.sections[1].solution; // e.g. solutions were not shared
    j.sections[1].blocks[0].text = "Evaluate $\\int x^2 e^x dx$";
    const { changes } = parseReturnedNotebook(JSON.stringify(j), current);
    expect(changes).toHaveLength(1);
    const c = changes[0];
    if (c.kind !== "update") throw new Error("expected update");
    expect(c.fields).toEqual(["title", "blocks"]);
    const after = applyPatch(current[1].data, c.patch);
    expect(after.solution).toBe("SECRET-SOLUTION");
    expect(after.blocks[1]).toEqual({ type: "image", src: PNG_DATA_URL, alt: "graph" });
    expect(after.minHeight).toBe(500);
  });

  it("adds new sections, skips duplicates and never deletes", () => {
    const j = exported();
    j.sections = [j.sections[0], j.sections[0], { title: "New Q", blocks: [{ type: "markdown", text: "hi" }] }, { id: "unknown", title: "No blocks" }];
    const r = parseReturnedNotebook(JSON.stringify(j), current);
    expect(r.changes.map((c) => c.kind)).toEqual(["add"]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join(" ")).toMatch(/twice/);
    expect(r.problems.join(" ")).toMatch(/no blocks/);
  });

  it("resolves images the agent returned and rejects unknown ones", () => {
    const j = exported();
    j.sections[0].blocks.push({ type: "image", src: "out/plot.png" });
    const ok = parseReturnedNotebook(JSON.stringify(j), current, [{ path: "plot.png", mime: "image/png", base64: PNG_B64 }]);
    expect(ok.changes).toHaveLength(1);
    expect(ok.changes[0].kind === "update" && ok.changes[0].patch.blocks?.at(-1)).toMatchObject({ src: PNG_DATA_URL });
    const bad = parseReturnedNotebook(JSON.stringify(j), current);
    expect(bad.changes).toEqual([]);
    expect(bad.problems[0]).toMatch(/out\/plot.png/);
    j.sections[0].blocks.push({ type: "image", src: "javascript:alert(1)" });
    expect(parseReturnedNotebook(JSON.stringify(j), current).changes).toEqual([]);
  });

  it("reports invalid JSON and schema errors instead of throwing", () => {
    expect(parseReturnedNotebook("{nope", current).problems[0]).toMatch(/not valid JSON/);
    expect(parseReturnedNotebook(JSON.stringify({ sections: [{ blocks: [{ type: "video" }] }] }), current).problems[0]).toMatch(/notebook.json/);
  });
});

describe("server: job files", () => {
  let session: string;
  beforeEach(async () => {
    configureAuthEnv();
    session = sessionCookie();
    await freshDb();
  });
  const create = (files: unknown, options: object = {}) => createJobRoute(req("/api/jobs", { body: { notebookId: "nb", sectionId: "s", agent: "claude", question: "Q", files, options }, session }));

  it("rejects unsafe paths, duplicates, wrong encodings and oversize bundles", async () => {
    const t = (path: string) => ({ path, mime: "text/markdown", text: "x" });
    for (const p of ["../x.md", ".hidden", "a/b/c.md", "/abs.md", "a\\\\b.md", "", "x".repeat(200)]) expect((await create([t(p)])).status, p).toBe(400);
    expect((await create([t("a.md"), t("A.md")])).status).toBe(400);
    expect((await create([{ path: "a.png", mime: "image/png", text: "x" }])).status).toBe(400);
    expect((await create([{ path: "a.md", mime: "text/markdown", base64: "AAAA" }])).status).toBe(400);
    expect((await create([{ path: "a.sh", mime: "application/x-sh", text: "rm -rf" }])).status).toBe(400);
    expect((await create([{ path: "a.png", mime: "image/png", base64: "A".repeat(MAX_BUNDLE_BYTES + 4) }])).status).toBe(400);
    expect((await create([t("ok.md")], { allowEdits: true, allowCode: true })).status).toBe(201);
  });

  it("hands files to the claimer, drops them on finish, and keeps returned files", async () => {
    const { getSql } = await import("@/server/db");
    const sql = (await getSql())!;
    const { token } = await createDeviceToken(sql, "mac", "pclk");
    const b = build({ scope: "sections", sectionIds: ["s1"] });
    const res = await create(b.files, { allowEdits: true });
    const id = ((await res.json()) as { job: { id: string } }).job.id;

    const listed = await listJobsRoute(req("/api/jobs?sectionId=s", { session }));
    expect(JSON.stringify(await listed.json())).not.toContain("Key idea"); // inputs never listed

    const device = (await sql.query<{ id: string }>("select id from device_tokens"))[0].id;
    const claimed = await claimJob(sql, device, ["claude"]);
    expect(claimed!.files).toEqual(b.files);
    expect(claimed!.options).toEqual({ allowEdits: true });

    const out = [{ path: "notebook.json", mime: "application/json", text: '{"sections":[]}' }, { path: "plot.png", mime: "image/png", base64: PNG_B64 }];
    // Files only come with the final "done" update.
    expect((await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body: { output: "x", files: out }, bearer: token }), params({ id }))).status).toBe(400);
    expect((await bridgeUpdate(req(`/api/bridge/jobs/${id}`, { body: { output: "done", status: "done", files: out }, bearer: token }), params({ id }))).status).toBe(200);

    const row = (await sql.query<{ files: unknown; context: string }>("select files, context from jobs where id = $1", [id]))[0];
    expect(row.files).toBeNull();
    const list = (await (await listJobsRoute(req("/api/jobs?sectionId=s", { session }))).json()) as { jobs: { resultFiles: object[] }[] };
    expect(list.jobs[0].resultFiles).toEqual([
      { path: "notebook.json", mime: "application/json", size: 15 },
      { path: "plot.png", mime: "image/png", size: PNG_B64.length },
    ]);
    const full = (await (await getJobRoute(req(`/api/jobs/${id}`, { session }), params({ id }))).json()) as { job: { resultFiles: object[] } };
    expect(full.job.resultFiles).toEqual([
      { path: "notebook.json", mime: "application/json", size: 15, text: '{"sections":[]}' },
      { path: "plot.png", mime: "image/png", size: PNG_B64.length, base64: PNG_B64 },
    ]);
  });

  it("refuses more returned files than the cap", async () => {
    const { resultFilesSchema } = await import("@/server/jobs");
    const many = Array.from({ length: MAX_RESULT_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, mime: "text/markdown", text: "x" }));
    expect(resultFilesSchema.safeParse(many).success).toBe(false);
    expect(resultFilesSchema.safeParse([{ path: "big.md", mime: "text/markdown", text: "x".repeat(MAX_RESULT_BYTES + 1) }]).success).toBe(false);
  });
});

describe("bridge: job dir for bundles", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "padsync-ctxdir-")));
  });
  const md = (path: string) => ({ path, mime: "text/markdown", text: "x" });

  it("safeJoin refuses anything that would leave the dir", () => {
    for (const p of ["../x", "a/../../x", "/etc/passwd", ".ssh/id", "a/b/c", "", "a/", "x\u0000"]) expect(() => safeJoin(root, p), p).toThrow();
    expect(safeJoin(root, "renders/01-q.png")).toBe(join(root, "renders", "01-q.png"));
  });

  it("refuses inputs in out/ or with unsafe names, and leaves nothing behind", async () => {
    await expect(prepareJobDir({ image: null, context: "", files: [md("out/notebook.json")] }, root)).rejects.toThrow(/out/);
    await expect(prepareJobDir({ image: null, context: "", files: [md("README.md"), md("../evil.md")] }, root)).rejects.toThrow(/unsafe/);
    await expect(prepareJobDir({ image: null, context: "", files: [md("a.md"), md("a.md")] }, root)).rejects.toThrow(/EEXIST/);
    expect(await readdir(root)).toEqual([]);
  });

  it("removes the dir after success and after a throw", async () => {
    let seen = "";
    await withJobDir({ image: null, context: "", files: [md("README.md")] }, async (d) => void (seen = d.dir), root);
    await expect(withJobDir({ image: null, context: "", files: [md("README.md")] }, async () => Promise.reject(new Error("boom")), root)).rejects.toThrow("boom");
    expect(seen).not.toBe("");
    expect(await readdir(root)).toEqual([]);
  });

  it("collects out/: one folder deep, regular files, safe names, valid text, within caps", async () => {
    const out = join(root, "out");
    await mkdir(join(out, "sub", "deeper"), { recursive: true });
    await writeFile(join(out, "notebook.json"), "{}");
    await writeFile(join(out, "plot.png"), Buffer.from(PNG_B64, "base64"));
    await writeFile(join(out, "sub", "a.md"), "# a");
    await writeFile(join(out, "sub", "deeper", "b.md"), "# b");
    await writeFile(join(out, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await writeFile(join(out, ".secret"), "x");
    await writeFile(join(out, "with space.md"), "x");
    await symlink("/etc/hosts", join(out, "link.md"));
    const got = await collectOutFiles(out);
    expect(got.files.map((f) => f.path)).toEqual(["notebook.json", "plot.png", "sub/a.md"]);
    expect(got.files.find((f) => f.path === "plot.png")).toEqual({ path: "plot.png", mime: "image/png", base64: PNG_B64 });
    expect(got.files.find((f) => f.path === "notebook.json")!.mime).toBe("application/json");
    expect(got.skipped.join("\n")).toMatch(/\.secret/);
    expect(got.skipped.join("\n")).toMatch(/link\.md \(not a regular file\)/);
    expect(got.skipped.join("\n")).toMatch(/sub\/deeper\//);
    expect(got.skipped.join("\n")).toMatch(/blob\.bin \(binary file\)/);
    expect(got.skipped.join("\n")).toMatch(/with space/);
  });

  it("caps the number and size of returned files", async () => {
    const out = join(root, "out");
    await mkdir(out);
    for (let i = 0; i < MAX_RESULT_FILES + 3; i++) await writeFile(join(out, `f${String(i).padStart(2, "0")}.md`), "x");
    expect((await collectOutFiles(out)).files).toHaveLength(MAX_RESULT_FILES);
    const out2 = join(root, "out2");
    await mkdir(out2);
    await writeFile(join(out2, "a.md"), "x".repeat(MAX_RESULT_BYTES - 10));
    await writeFile(join(out2, "b.md"), "x".repeat(100));
    const got = await collectOutFiles(out2);
    expect(got.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(got.skipped[0]).toMatch(/b\.md/);
    expect(await collectOutFiles(join(root, "missing"))).toEqual({ files: [], skipped: [] });
  });

  it("prompt lists absolute paths, includes only the given texts, and describes out/ only when editing", () => {
    const b = build();
    const d = { dir: "/t/padsync-job-1", out: "/t/padsync-job-1/out", files: b.files.map(({ path, mime }) => ({ path, mime })) };
    const p = buildBundlePrompt("Fix Q1", d, "claude", { allowEdits: true });
    expect(p).toContain("`/t/padsync-job-1/notebook.md`");
    expect(p).toContain("`/t/padsync-job-1/renders/02-q1.png`");
    expect(p).toContain("/t/padsync-job-1/out/");
    expect(p).not.toContain("SECRET");
    expect(p).not.toContain("IBP");
    expect(buildBundlePrompt("Q", d, "claude", {})).toContain("Do not create or modify any files.");
    expect(buildBundlePrompt("Q", d, "codex", {})).toContain("renders/02-q1.png`: a render of a section: printed content plus my handwriting (attached to this message)");
    // Markdown goes in the prompt (sparing the agent a read); notebook.json, which repeats it, doesn't.
    const inline = inlineTexts(b.files.map((f) => ({ ...f })));
    expect(inline.map((f) => f.path)).toEqual(["README.md", "notebook.md"]);
    const withText = buildBundlePrompt("Q", d, "claude", {}, inline);
    expect(withText).toContain('<file path="notebook.md">\n' + file(b, "notebook.md")!.text);
    expect(withText).toContain("notebook.md`: the chosen sections: printed content, my typed notes, and possibly reference solutions I have NOT seen (included below)");
    expect(withText.indexOf("<file")).toBeLessThan(withText.indexOf("My question:"));
    expect(inlineTexts([{ path: "a.md", mime: "text/markdown", text: "x".repeat(INLINE_TEXT_CHARS + 1) }])).toEqual([]);
  });

  it("edit and code flags: Claude gets write tools in acceptEdits, Bash only with code; Codex gets workspace-write", () => {
    const after = (a: string[], f: string) => a[a.indexOf(f) + 1];
    const ro = agentCommand("claude", {}, [], {});
    expect(after(ro.args, "--tools")).toBe("Read");
    expect(ro.args).not.toContain("--permission-mode");
    const ed = agentCommand("claude", {}, [], { allowEdits: true });
    expect(after(ed.args, "--tools")).toBe("Read,Glob,Grep,Write,Edit");
    expect(after(ed.args, "--permission-mode")).toBe("acceptEdits");
    // Pre-approving Write/Edit would allow them anywhere; acceptEdits limits them to the cwd.
    const approved = ed.args.slice(ed.args.indexOf("--allowedTools") + 1, ed.args.indexOf("--disallowedTools"));
    expect(approved).toEqual(["Read", "Glob", "Grep"]);
    expect(ed.args.slice(ed.args.indexOf("--disallowedTools") + 1)).toContain("Bash");
    const code = agentCommand("claude", {}, [], { allowEdits: true, allowCode: true });
    expect(after(code.args, "--tools")).toContain("Bash");
    expect(JSON.parse(after(code.args, "--settings")).sandbox.enabled).toBe(true);
    // Code without edits is ignored.
    expect(after(agentCommand("claude", {}, [], { allowCode: true }).args, "--tools")).toBe("Read");
    expect(after(agentCommand("codex", {}, [], { allowEdits: true }).args, "--sandbox")).toBe("workspace-write");
    expect(after(agentCommand("codex", {}, [], {}).args, "--sandbox")).toBe("read-only");
    const imgs = attachedImages(build().files);
    expect(imgs).toEqual([IMG, "renders/01-key-idea.png", "renders/02-q1.png", "renders/03-q2.png"]);
    expect(agentCommand("codex", {}, imgs, {}).args.filter((a) => a === "--image")).toHaveLength(4);
  });
});

describe("controls render", () => {
  it("shows the section list, the selection picker and the exact preview", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BundlePreview, ContextControls } = await import("@/components/ContextControls");
    const sections = nb().map((s, i) => ({ id: s.id, kind: "section", notebookId: "nb", parentId: "", hlc: "", deleted: 0, dirty: 0, data: { ...s.data, order: i } })) as never[];
    const props = { set: () => {}, sections, pickedIds: ["s1"], setPickedIds: () => {}, currentId: "s2", source: "Evaluate", textSel: null, setTextSel: () => {}, lassoCount: 2, summary: "3 sections · ~4k tokens" };
    const listHtml = renderToStaticMarkup(createElement(ContextControls, { ...props, o: opts({ scope: "sections" }) }));
    expect(listHtml).toContain("Only this one");
    expect(listHtml).toContain("1 / 3");
    expect(listHtml).toContain("3 sections · ~4k tokens");
    const selHtml = renderToStaticMarkup(createElement(ContextControls, { ...props, o: opts({ scope: "selection" }) }));
    expect(selHtml).toContain("2 strokes lassoed");
    expect(selHtml).toContain("Section text to select from");
    const b = build();
    const prev = renderToStaticMarkup(createElement(BundlePreview, { bundle: b, onClose: () => {} }));
    for (const f of b.files) expect(prev).toContain(f.path);
    // notebook.md is open by default and shown verbatim (escaped).
    expect(prev).toContain("## 2. Q1 [3 marks]");
  });
});

describe("fixes after second opinion", () => {
  it("images off also hides remote URLs, and they still round-trip", () => {
    const secs = [section("s1", { blocks: [{ type: "image", src: "https://private.test/x.png", alt: "x" }] })];
    const b = build({ images: false, renders: false }, secs);
    expect(JSON.stringify(b.files)).not.toContain("private.test");
    expect(file(build({ renders: false }, secs), "notebook.md")!.text).toContain("https://private.test/x.png");
    const back = parseReturnedNotebook(file(b, "notebook.json")!.text!, secs.map(({ id, data }) => ({ id, data })));
    expect(back).toEqual({ changes: [], problems: [] });
  });

  it("the same embedded image twice in a section is one file", () => {
    const img = { type: "image" as const, src: PNG_DATA_URL };
    const b = build({ renders: false }, [section("s1", { blocks: [img, img] })]);
    expect(b.files.filter((f) => f.path.startsWith("assets/"))).toHaveLength(1);
    expect(newJobSchema.safeParse({ notebookId: "n", sectionId: null, agent: "claude", question: "q", files: b.files }).success).toBe(true);
  });

  it("an image replaced while the job ran is not silently swapped in", () => {
    const b = build({ renders: false });
    const live = nb().map(({ id, data }) => ({ id, data }));
    live[1].data = { ...live[1].data, blocks: live[1].data.blocks.map((x) => (x.type === "image" ? { ...x, src: "data:image/png;base64,AAAA" } : x)) };
    const r = parseReturnedNotebook(file(b, "notebook.json")!.text!, live);
    expect(r.changes).toEqual([]);
    expect(r.problems[0]).toMatch(/not one that was sent/);
  });

  it("signatures use full revisions, so same-millisecond edits still differ", () => {
    const s = nb().map((x) => ({ ...x, revision: "1800000000000-0001-dev" }));
    const t = s.map((x, i) => (i ? x : { ...x, revision: "1800000000000-0002-dev" }));
    expect(bundleSignature("T", s, null, opts())).not.toBe(bundleSignature("T", t, null, opts()));
  });

  it("refuses an out/ that is a symlink, even to a folder inside tmp", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "padsync-outlink-")));
    await mkdir(join(root, "elsewhere", "sub"), { recursive: true });
    await writeFile(join(root, "elsewhere", "secret.md"), "x");
    await mkdir(join(root, "job", "out"), { recursive: true });
    await symlink(join(root, "elsewhere", "sub"), join(root, "job", "out", "sub"));
    const linkOut = join(root, "job2-out");
    await symlink(join(root, "elsewhere"), linkOut);
    expect((await collectOutFiles(linkOut)).files).toEqual([]);
    const got = await collectOutFiles(join(root, "job", "out"));
    expect(got.files).toEqual([]);
    expect(got.skipped[0]).toMatch(/sub/);
  });
});
