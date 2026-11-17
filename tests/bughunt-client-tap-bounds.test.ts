import { expect, it } from "vitest";
import { dataBox } from "@/ink/geometry";
import type { StrokeData } from "@/lib/types";

// A tap is drawn with a 0.8 px minimum radius (render.ts), so its dirty box must reach that far
// or the neighbouring tile clips the dot.
it("small pen taps include the rendered minimum radius in their dirty bounds", () => {
  const data: StrokeData = { tool: "pen", size: 0.5, input: "pen", color: "#000", device: "test", t0: 0, pts: [10, 768.6, 0, 0, 0, 0] };
  const box = dataBox(data);
  expect(box.minY).toBeCloseTo(767.8, 10);
  expect(box.maxY).toBeCloseTo(769.4, 10);
});
