import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const nextConfig: NextConfig = {
  compiler: {
    async runAfterProductionCompile({ distDir, projectDir }) {
      // ClientOnly loads each screen dynamically. Its HTML alone cannot boot offline.
      const root = path.join(distDir, "static");
      const files = await readdir(root, { recursive: true, withFileTypes: true });
      const assets = files.filter(file => file.isFile() && !file.name.endsWith(".map"))
        .map(file => path.relative(root, path.join(file.parentPath, file.name)).split(path.sep).join("/"))
        // Vercel places content-addressed files under static/immutable/. Keep that prefix in the URL.
        .filter(file => /^(?:immutable\/)?(?:chunks|media)\//.test(file))
        .map(file => "/_next/static/" + file).sort();
      if (!assets.some(file => file.endsWith(".js"))) throw new Error("Missing offline app chunks");
      const manifest = { cache: "padsync-build-" + randomUUID(), assets };
      await writeFile(path.join(projectDir, "public/sw-assets.js"), `self.padSyncBuild = ${JSON.stringify(manifest)};\n`);
    },
  },
  cacheComponents: true,
  // AI import (and the prompt page before it) was removed; old links land in the library.
  async redirects() {
    return [{ source: "/import", destination: "/", permanent: false }, { source: "/prompt", destination: "/", permanent: false }];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
