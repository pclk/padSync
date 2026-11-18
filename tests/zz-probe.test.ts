import { it } from "vitest";
import sharp from "sharp";
import { getStroke } from "perfect-freehand";
import { strokeOptions, toInput } from "@/ink/render";
import type { StrokeData } from "@/lib/types";

const OUT = "/private/tmp/claude-501/-Users-weiheng-Repo-padSync/0c030fea-72b5-46fc-9dcd-e70b0b11c45e/scratchpad/probe/";
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

// Polyline through waypoints, sampled at 240 Hz at `speed` px/s, quantized to q.
function shape(way: number[][], speed: number, q: number, pen = true): StrokeData {
  const pts: number[] = []; let t = 0;
  for (let k = 1; k < way.length; k++) {
    const [x0, y0] = way[k - 1], [x1, y1] = way[k];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / (speed / (pen ? 240 : 60))));
    for (let j = k === 1 ? 0 : 1; j <= n; j++) {
      let x = x0 + ((x1 - x0) * j) / n + 0.15 * rnd(), y = y0 + ((y1 - y0) * j) / n + 4 * Math.sin((x0 + ((x1 - x0) * j) / n) / 60) + 0.15 * rnd();
      if (q) { x = Math.round(x / q) * q; y = Math.round(y / q) * q; }
      pts.push(x, y, pen ? 0.4 + 0.04 * rnd() : 0.5, 1, 0, t); t += 4;
    }
  }
  return { tool: "pen", color: "#111", size: 3.4, pts, t0: 0, input: pen ? "pen" : "mouse", device: "d" };
}
const arrow = (q: number, pen = true) => shape([[20, 0], [260, 0], [225, -14], [262, 0], [228, 14]], 250, q, pen);
const zig = (q: number) => shape([[20, 0], [50, -12], [80, 12], [110, -12], [140, 12], [170, -12]], 300, q);

function decimate(input: number[][], D: number): number[][] {
  const kept: number[][] = [input[0]];
  for (let i = 1; i < input.length; i++) {
    const [x, y] = kept[kept.length - 1];
    if (Math.hypot(input[i][0] - x, input[i][1] - y) >= D) kept.push(input[i]);
  }
  if (input.length > 1 && kept[kept.length - 1] !== input[input.length - 1]) kept.push(input[input.length - 1]);
  return kept;
}
function binomial(p: number[][], w: number[]): number[][] {
  const r = (w.length - 1) / 2;
  return p.map((pt, i) => {
    const h = Math.min(r, i, p.length - 1 - i);
    if (h === 0) return pt;
    let sx = 0, sy = 0, sw = 0;
    for (let k = -h; k <= h; k++) { const ww = w[k + r]; sx += p[i + k][0] * ww; sy += p[i + k][1] * ww; sw += ww; }
    return [sx / sw, sy / sw, pt[2]];
  });
}
function path(o: number[][]) {
  let s = `M${o[0][0]} ${o[0][1]}`;
  for (let i = 1; i < o.length; i++) { const [a, b] = o[i], [c, d] = o[(i + 1) % o.length]; s += `Q${a} ${b} ${(a + c) / 2} ${(b + d) / 2}`; }
  return s + "Z";
}

it("probe", async () => {
  const variants: [string, (i: number[][]) => number[][]][] = [
    ["current", (i) => i],
    ["D2 + [1,2,1]x2", (i) => binomial(binomial(decimate(i, 2), [1, 2, 1]), [1, 2, 1])],
    ["D1.5 + [1,4,6,4,1]", (i) => binomial(decimate(i, 1.5), [1, 4, 6, 4, 1])],
    ["D2 + [1,4,6,4,1]", (i) => binomial(decimate(i, 2), [1, 4, 6, 4, 1])],
  ];
  const inputs: [string, StrokeData][] = [["arrow q1", arrow(1)], ["arrow q0.5", arrow(0.5)], ["zigzag q1", zig(1)], ["mac arrow", arrow(0.5, false)]];
  let body = "", y = 25;
  for (const [vn, f] of variants) {
    let x = 0;
    for (const [n, d] of inputs) {
      const o = getStroke(f(toInput(d.pts, d.input)), strokeOptions(d, true));
      body += `<g transform="translate(${x} ${y})"><path d="${path(o)}" fill="#111"/></g>`;
      x += 290;
    }
    body += `<text x="2" y="${y - 16}" font-size="8" font-family="Helvetica">${vn}</text>`;
    y += 50;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2320" height="${y * 2}" viewBox="0 0 1160 ${y}"><rect width="1160" height="${y}" fill="white"/>${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(OUT + "v2.png");
});
