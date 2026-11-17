import { expect, it } from "vitest";
import { importJobBody } from "@/lib/ai-import";

it("does not split an emoji at the question limit", () => {
  const body = importJobBody({ request: "a".repeat(3999) + "😀", goals: [], agent: "claude" } as Parameters<typeof importJobBody>[0], [], []);
  expect(body.question).toBe("a".repeat(3999));
});
