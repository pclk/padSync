import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOutFiles } from "../bridge/lib";
import { buildBundle, DEFAULT_CONTEXT, BUNDLE_PATH_RE, type SectionInput } from "@/lib/context";
import { parseReturnedNotebook } from "@/lib/roundtrip";

const section = (src = "data:image/png;base64,YQ=="): SectionInput => ({
  id: "s1", lastActivity: 1000, notes: [],
  data: { order: 1, createdAt: 0, minHeight: 500, template: "plain", blocks: [{ type: "image", src }] },
});

describe("second-opinion context regressions", () => {
  // These were expected failures documenting bugs; fixed, so they now run as normal tests.
  it("does not follow a symlink replacing the out root", async () => {
    const root = await mkdtemp(join(tmpdir(), "sol-context-"));
    try {
      await mkdir(join(root, "external"));
      await writeFile(join(root, "external", "private.txt"), "outside data");
      await symlink(join(root, "external"), join(root, "out"));
      expect((await collectOutFiles(join(root, "out"))).files).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks a crop-only selection when its only content exceeds the budget", () => {
    const b = buildBundle({ title: "N", sections: [section()], maxBytes: 10_000,
      selection: { sectionId: "s1", crop: { base64: "A".repeat(20_000), width: 100, height: 100 } },
    }, { ...DEFAULT_CONTEXT, scope: "selection" });
    expect(b.error).toBeTruthy();
  });

  it("resolves a returned image against the exported snapshot after blocks move", () => {
    const original = section();
    const b = buildBundle({ title: "N", sections: [original] }, { ...DEFAULT_CONTEXT, renders: false });
    const text = b.files.find(f => f.path === "notebook.json")!.text!;
    const live = section("data:image/png;base64,Yg==");
    const parsed = parseReturnedNotebook(text, [live]);
    // The returned asset represented image A. It must not silently become live image B.
    // (Adjusted after the fix: references are content-addressed, so A no longer resolves once it
    // was replaced; the section is reported instead of patched. Restoring A would need the sent
    // bundle kept client-side, which padSync doesn't do.)
    expect(JSON.stringify(parsed.changes)).not.toContain("Yg==");
    expect(parsed.problems.join(" ")).toMatch(/not one that was sent/);
  });

  it("omits remote image URLs when embedded images are disabled", () => {
    const b = buildBundle({ title: "N", sections: [section("https://example.org/private.png")] },
      { ...DEFAULT_CONTEXT, images: false, renders: false });
    expect(JSON.stringify(b.files)).not.toContain("https://example.org/private.png");
  });

  it("rejects an empty text selection", () => {
    expect(buildBundle({ title: "N", sections: [section()], selection: { sectionId: "s1", text: "  " } },
      { ...DEFAULT_CONTEXT, scope: "selection" }).error).toBeTruthy();
  });

  it.each(["../secret", "out/../secret", "/tmp/secret", "assets/.hidden", "a/b/c", "a\\b"])("rejects unsafe input path %s", path => {
    expect(BUNDLE_PATH_RE.test(path)).toBe(false);
  });
});
