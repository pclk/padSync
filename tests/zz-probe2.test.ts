import { it } from "vitest";
import sharp from "sharp";
import { strokeSvgPath } from "@/ink/render";
import type { StrokeData } from "@/lib/types";
const OUT = "/private/tmp/claude-501/-Users-weiheng-Repo-padSync/0c030fea-72b5-46fc-9dcd-e70b0b11c45e/scratchpad/probe/";
// Small cursive loops (x-height ~10 px) written at `speed` px/s, sampled at `hz`, with a landing hook.
function loops(hz: number, speed: number, y0: number): StrokeData {
  const pts: number[] = []; let t = 0; const dt = 1000 / hz;
  // landing hook: 3 px sideways jab at low pressure
  pts.push(18, y0 + 8, 0.02, 1, 0, 0, 16, y0 + 5, 0.06, 1, 0, 4);
  let a = -Math.PI / 2, x = 20;
  const len = 6 * Math.PI * 2;
  while (a < len) {
    const px = x + 4 * a - 5 * Math.sin(a), py = y0 + 5 * Math.cos(a);
    pts.push(Math.round(px * 100) / 100, Math.round(py * 100) / 100, 0.45, 1, 0, (t += dt));
    // advance by arc length speed*dt/1000
    const ds = Math.hypot(4 - 5 * Math.cos(a), -5 * Math.sin(a));
    a += (speed * dt / 1000) / Math.max(ds, 0.5);
  }
  const [lx, ly] = [pts[pts.length - 6], pts[pts.length - 5]];
  pts.push(lx + 2, ly - 3, 0.05, 1, 0, (t += dt));
  return { tool: "pen", color: "#111", size: 2.2, pts, t0: 0, input: "pen", device: "d" };
}
it("probe2", async () => {
  const rows: [string, StrokeData][] = [["240Hz 250px/s", loops(240, 250, 20)], ["120Hz 400px/s", loops(120, 400, 50)], ["60Hz 400px/s", loops(60, 400, 80)]];
  let body = "";
  for (const [n, d] of rows) body += `<path d="${strokeSvgPath(d)}" fill="#111"/><text x="200" y="${d.pts[7] + 4}" font-size="7" font-family="Helvetica">${n}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${100 * 4}" viewBox="0 0 300 100"><rect width="300" height="100" fill="white"/>${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(OUT + (process.env.NAME ?? "loops") + ".png");
});
