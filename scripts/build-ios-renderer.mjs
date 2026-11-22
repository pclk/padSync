// Builds the iPad app's bundled block renderer (ios/renderer) into ios/PadSync/Renderer: the
// web's own section components, Tailwind CSS, KaTeX and highlight.js styles, no server needed.
// It also bundles ios/realtime (the Neon realtime client for live sync notifications).
// Run after changing SectionContent.tsx, StudyBlocks.tsx, markdown.ts, globals.css or ios/realtime:
//   node scripts/build-ios-renderer.mjs
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "ios/PadSync/Renderer");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  root,
  configFile: false,
  logLevel: "warn",
  resolve: { alias: { "@": path.join(root, "src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: out,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: path.join(root, "ios/renderer/main.tsx"), formats: ["iife"], name: "padsyncRenderer", fileName: () => "renderer.js" },
  },
});

await build({
  root,
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: path.join(root, "ios/realtime/main.ts"), formats: ["iife"], name: "padsyncRealtimeBundle", fileName: () => "realtime.js" },
  },
});

// Tailwind: only the classes the shared components use, on top of globals.css (theme, .paper, prose).
const globals = path.join(root, "src/app/globals.css");
const compiler = await compile(await readFile(globals, "utf8"), { base: path.dirname(globals), onDependency: () => {} });
const scanner = new Scanner({ sources: [{ base: root, pattern: "src/components/{SectionContent,StudyBlocks}.tsx", negated: false }, { base: root, pattern: "ios/renderer/*.tsx", negated: false }] });
const tailwind = compiler.build(scanner.scan());

const katexDir = path.join(root, "node_modules/katex/dist");
const katex = await readFile(path.join(katexDir, "katex.min.css"), "utf8");
const hljs = await readFile(path.join(root, "node_modules/highlight.js/styles/github.css"), "utf8");
await writeFile(path.join(out, "renderer.css"), `${katex}\n${hljs}\n${tailwind}`);
await cp(path.join(katexDir, "fonts"), path.join(out, "fonts"), { recursive: true, filter: (f) => !/\.(ttf|woff)$/.test(f) });
await cp(path.join(root, "ios/renderer/index.html"), path.join(out, "index.html"));
console.log("Built", path.relative(root, out));
