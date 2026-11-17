import { describe, expect, it } from "vitest";
import {
  EFFORTS,
  MODELS,
  editNeedsFork,
  hasNewOutput,
  queuedAfterPrevious,
  relativeTime,
  validateAttachments,
} from "../src/lib/chat-ui";
import type { Turn } from "../src/lib/chat-types";
const turn = (overrides: Partial<Turn> = {}): Turn => ({
  jobId: "one",
  turn: 1,
  question: "Hi",
  output: "",
  outputOffset: 0,
  context: null,
  attachments: [],
  agent: "claude",
  options: {},
  status: "running",
  error: null,
  createdAt: "2026-11-17",
  updatedAt: "2026-11-17",
  finishedAt: null,
  resultFiles: [],
  ...overrides,
});
describe("Chat client presentation decisions", () => {
  it("detects new output without treating status or scroll changes as text", () => {
    expect(hasNewOutput([turn()], [turn({ status: "done" })])).toBe(false);
    expect(hasNewOutput([turn()], [turn({ output: "hello" })])).toBe(true);
    expect(
      hasNewOutput([turn({ output: "hello" })], [turn({ output: "hello" })]),
    ).toBe(false);
    expect(hasNewOutput([], [turn()])).toBe(false);
  });
  it("formats relative timestamps from the shared advancing clock", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    expect(relativeTime(new Date(now).toISOString(), now)).toBe("Just now");
    expect(relativeTime(new Date(now).toISOString(), now + 60000)).toBe(
      "1m ago",
    );
    expect(relativeTime(new Date(now).toISOString(), now + 3600000)).toBe(
      "1h ago",
    );
  });
  it("validates supported attachment types, count, individual and combined sizes", () => {
    const file = { name: "page.png", type: "image/png", size: 100 };
    expect(validateAttachments([file])).toBeNull();
    expect(validateAttachments([{ ...file, type: "image/svg+xml" }])).toContain(
      "image or PDF",
    );
    expect(validateAttachments([{ ...file, size: 25000001 }])).toContain(
      "25 MB",
    );
    expect(validateAttachments([{ ...file, size: 0 }])).toContain("empty");
    expect(validateAttachments(Array(21).fill(file))).toContain("20");
    expect(
      validateAttachments(Array(2).fill({ ...file, size: 21000000 })),
    ).toContain("40 MB");
  });
  it("retains all legacy model and per-agent effort choices", () => {
    expect(MODELS.claude.map(([value]) => value)).toEqual([
      "",
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(MODELS.codex.map(([value]) => value)).toEqual([
      "",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(EFFORTS.codex).toContain("ultra");
    expect(EFFORTS.claude).not.toContain("ultra");
  });
  it("marks only queued turns behind an unfinished earlier reply", () => {
    const queued = turn({ jobId: "two", turn: 2, status: "queued" });
    expect(queuedAfterPrevious(queued, [turn(), queued])).toBe(true);
    expect(
      queuedAfterPrevious(queued, [turn({ status: "error" }), queued]),
    ).toBe(false);
    expect(queuedAfterPrevious(turn(), [turn(), queued])).toBe(false);
  });
  it("offers the composer fork fallback only for an edit conflict", () => {
    expect(
      editNeedsFork(
        Object.assign(new Error("Context cannot be copied"), { status: 409 }),
      ),
    ).toBe(true);
    expect(editNeedsFork(new Error("Offline"))).toBe(false);
    expect(editNeedsFork({ status: 500 })).toBe(false);
  });
});
