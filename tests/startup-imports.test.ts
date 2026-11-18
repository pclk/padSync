import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

// The notebook screen loads everything it imports statically before it can draw. zod (~110 KB) and
// html-to-image are only needed to review AI-returned changes or make an image, so they load then.

const src = join(__dirname, "../src");

function staticPackages(entry: string) {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(src, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      if (!spec.startsWith(".") && !spec.startsWith("@/")) {
        packages.add(spec);
        continue;
      }
      const base = spec.startsWith("@/") ? join(src, spec.slice(2)) : resolve(dirname(file), spec);
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsSync(p) && statSync(p).isFile());
      if (found) queue.push(found);
    }
  }
  return packages;
}

it("keeps zod and html-to-image out of the notebook's startup imports", () => {
  const packages = staticPackages("components/NotebookEditor.tsx");
  expect(packages.has("perfect-freehand")).toBe(true); // the walk reaches the ink code
  expect([...packages].filter((p) => p === "zod" || p.startsWith("zod/") || p === "html-to-image")).toEqual([]);
});
