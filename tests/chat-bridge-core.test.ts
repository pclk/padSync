import { expect, it } from "vitest";
import {
  agentCommand,
  resumeCommand,
  parseSessionId,
  chatHistory,
  expiredSession,
} from "../bridge/lib";
it("Resume arguments for both agents", () => {
  expect(
    resumeCommand(agentCommand("claude", {}, false), "claude", "abc").args,
  ).toContain("--resume");
  const args = resumeCommand(
    agentCommand("codex", {}, false),
    "codex",
    "abc",
  ).args;
  expect(
    args.slice(args.indexOf("resume"), args.indexOf("resume") + 2),
  ).toEqual(["resume", "abc"]);
});
it("Session IDs parsed from init, result and thread.started stream lines", () => {
  expect(
    parseSessionId('{"type":"system","subtype":"init","session_id":"a"}'),
  ).toBe("a");
  expect(parseSessionId('{"type":"result","session_id":"b"}')).toBe("b");
  expect(parseSessionId('{"type":"thread.started","thread_id":"c"}')).toBe("c");
});
it("Expired resume triggers history fallback; history capped at 60k newest kept", () => {
  expect(expiredSession("Session not found")).toBe(true);
  expect(expiredSession("network error")).toBe(false);
  const h = chatHistory([
    { question: "old", output: "x".repeat(65000) },
    { question: "newest", output: "answer" },
  ]);
  expect(h.length).toBe(60000);
  expect(h).toContain("truncated");
  expect(h.endsWith("answer")).toBe(true);
});

it("Unknown resume retries once with history.md and never retries a failed fresh attempt", async () => {
  const { runChatWithFallback } = await import("../bridge/lib");
  const attempts: { resume: boolean; history: boolean }[] = [];
  const result = await runChatWithFallback(true, async (resume, history) => {
    attempts.push({ resume, history });
    return { status: "error", output: "", error: "Session not found" };
  });
  expect(result.status).toBe("error");
  expect(attempts).toEqual([
    { resume: true, history: false },
    { resume: false, history: true },
  ]);
});
