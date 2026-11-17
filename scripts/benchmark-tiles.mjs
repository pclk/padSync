// Run with node scripts/benchmark-tiles.mjs. Transpile in memory; no build artifacts.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadPackage = createRequire(import.meta.url);
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const mod = { exports: {} };
  cache.set(filename, mod.exports);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function('require', 'module', 'exports', source)((name) => {
    if (name.startsWith('@/')) return load(path.resolve(__dirname, '../src', name.slice(2) + '.ts'));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
    return loadPackage(name);
  }, mod, mod.exports);
  return mod.exports;
}
const { planTiles, TILE_H } = load(path.resolve(__dirname, '../src/ink/tiles.ts'));
const { strokeBox } = load(path.resolve(__dirname, '../src/ink/geometry.ts'));
function previous(height, strokes) {
  return Array.from({ length: Math.max(1, Math.ceil(height / TILE_H)) }, (_, i) => {
    const top = i * TILE_H, h = Math.min(TILE_H, height - top);
    return { top, h, strokes: strokes.filter(s => { const b = strokeBox(s); return b.maxY >= top && b.minY <= top + h; }) };
  });
}
for (const tiles of [10, 100]) {
  const height = TILE_H * tiles;
  const strokes = Array.from({ length: 10000 }, (_, i) => ({ id: `bench-${tiles}-${i}`, hlc: '1', data: {
    size: 3, pts: [0, (i * 137) % height, .5, 0, 0, 0, 30, (i * 137) % height + 30, .5, 1, 0, 0],
  } }));
  assert.deepEqual(planTiles(height, strokes), previous(height, strokes));
  for (let i = 0; i < 5; i++) { previous(height, strokes); planTiles(height, strokes); }
  const before = [], after = [];
  function measure(fn) { const start = performance.now(); fn(height, strokes); return performance.now() - start; }
  for (let i = 0; i < 21; i++) {
    if (i % 2) { after.push(measure(planTiles)); before.push(measure(previous)); }
    else { before.push(measure(previous)); after.push(measure(planTiles)); }
  }
  const median = values => values.sort((a, b) => a - b)[10];
  console.log(JSON.stringify({ strokes: strokes.length, tiles, previousMs: median(before), optimizedMs: median(after), samples: 21 }));
}
