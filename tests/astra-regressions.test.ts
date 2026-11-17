import { afterEach, expect, it, vi } from "vitest";
import { paintDelta } from "@/ink/tiles";
import type { StrokeEntity } from "@/lib/types";

afterEach(() => vi.restoreAllMocks());

it("ignores finite but malformed remote clocks", async () => {
  vi.resetModules();
  const { hlcNow, hlcObserve } = await import("@/lib/hlc");
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  hlcNow("d");
  hlcObserve("99999999999999-0000-d");
  hlcObserve("9000000000000-1.5-d");
  hlcObserve("9000000000000-0000");
  expect(hlcNow("d")).toBe("1700000000000-0001-d");
});

it("repaints when a tied pen is inserted before already painted ink", () => {
  const pen = (id: string): StrokeEntity => ({
    id, kind: "stroke", notebookId: "n", parentId: "s", hlc: "h", deleted: 0, dirty: 0,
    data: { tool: "pen", color: "#000", size: 2, t0: 10, input: "pen", device: "d", pts: [0, 0, 0.5, 0, 0, 0] },
  });
  const a = pen("a"), b = pen("b");
  expect(paintDelta([b], [a, b])).toBeNull();
});
