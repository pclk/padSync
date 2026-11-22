import { expect, it } from "vitest";
import { mergeTurns } from "@/lib/chat-api";
import type { Turn } from "@/lib/chat-types";
it("mergeTurns merges offsets and ignores duplicate, stale and missing-prefix ticks", () => {
  const a = {
    turn: 1,
    output: "abc",
    outputOffset: 0,
    updatedAt: "2026-01-01",
  } as Turn;
  const b = { ...a, output: "def", outputOffset: 3, updatedAt: "2026-01-02" };
  const merged = mergeTurns([a], [b]);
  expect(merged[0].output).toBe("abcdef");
  expect(mergeTurns(merged, [b, a])).toEqual(merged);
  expect(mergeTurns([], [b])).toEqual([]);
});

it("Maps signed-out, unconfigured database and offline errors", async () => {
  const { vi } = await import("vitest");
  const { listThreads } = await import("@/lib/chat-api");
  try {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "raw" }, { status: 401 }),
    );
    await expect(listThreads()).rejects.toThrow(
      "Sign in on the Settings page first.",
    );
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "raw" }, { status: 503 }),
    );
    await expect(listThreads()).rejects.toThrow(
      "Server database is not set up.",
    );
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(listThreads()).rejects.toThrow(
      "You're offline; chat needs a connection.",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("merges streamed thinking deltas and keeps it when a delta runs past what it has", () => {
  const base = { turn: 1, jobId: "j", question: "q", context: null, attachments: [], agent: "claude", options: {}, error: null, createdAt: "", finishedAt: null, resultFiles: [], output: "", outputOffset: 0, status: "running" } as unknown as Turn;
  let turns = mergeTurns([], [{ ...base, updatedAt: "1", thinking: "Check", thinkingOffset: 0 }]);
  turns = mergeTurns(turns, [{ ...base, updatedAt: "2", thinking: "ing", thinkingOffset: 5 }]);
  expect(turns[0].thinking).toBe("Checking");
  turns = mergeTurns(turns, [{ ...base, updatedAt: "3", thinking: "zzz", thinkingOffset: 50 }]);
  expect(turns[0].thinking).toBe("Checking");
});
