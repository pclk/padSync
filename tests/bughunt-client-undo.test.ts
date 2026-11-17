import { expect, it, vi } from "vitest";
import { UndoStack } from "@/ink/undo";

it("retains a failed undo for retry", async () => {
  const stack = new UndoStack();
  const undo = vi.fn().mockRejectedValueOnce(new Error("storage")).mockResolvedValue(undefined);
  stack.push({ label: "stroke", undo, redo: async () => {} });
  await expect(stack.undo()).rejects.toThrow("storage");
  expect(stack.canUndo).toBe(true);
  expect(await stack.undo()).toBe("stroke");
});

it("serializes overlapping undo and redo writes", async () => {
  const stack = new UndoStack();
  const calls: string[] = [];
  let release!: () => void;
  stack.push({ label: "stroke", undo: async () => { calls.push("undo"); await new Promise<void>((r) => { release = r; }); }, redo: async () => { calls.push("redo"); } });
  const undo = stack.undo();
  await Promise.resolve();
  const redo = stack.redo();
  release();
  await Promise.all([undo, redo]);
  expect(calls).toEqual(["undo", "redo"]);
  expect(stack.canUndo).toBe(true);
});
