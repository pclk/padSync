import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import config from "../next.config";

it.each(["", "immutable/"])("includes the emitted %schunks and media in the offline manifest", async prefix => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "padsync-offline-"));
  const distDir = path.join(projectDir, ".next");
  try {
    await mkdir(path.join(projectDir, "public"));
    for (const file of ["chunks/library.js", "chunks/library.js.map", "media/pdf.worker.mjs"]) {
      const location = path.join(distDir, "static", prefix, file);
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, "");
    }
    await config.compiler!.runAfterProductionCompile!({ projectDir, distDir });
    const script = await readFile(path.join(projectDir, "public/sw-assets.js"), "utf8");
    expect(script).toContain(`"/_next/static/${prefix}chunks/library.js"`);
    expect(script).toContain(`"/_next/static/${prefix}media/pdf.worker.mjs"`);
    expect(script).not.toContain(".map");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
