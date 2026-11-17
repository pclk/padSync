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
  const gate = new Promise<void>((r) => (release = r));
  stack.push({ label: "stroke", undo: async () => { calls.push("undo"); await gate; calls.push("undone"); }, redo: async () => { calls.push("redo"); } });
  // Redo is requested while the undo write is still in flight.
  const undo = stack.undo();
  const redo = stack.redo();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toEqual(["undo"]);
  release();
  await Promise.all([undo, redo]);
  expect(calls).toEqual(["undo", "undone", "redo"]);
  expect(await redo).toBe("stroke");
  expect(stack.canUndo).toBe(true);
});
