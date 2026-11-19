import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/chat-types";
import { BUILTIN_PRICES, formatUsd, parsePriceList, priceFor, turnCost, turnTokens } from "@/lib/chat-cost";

const turn = (over: Partial<Turn>): Turn => ({
  jobId: "j",
  turn: 1,
  question: "",
  context: null,
  attachments: [],
  agent: "claude",
  options: {},
  status: "done",
  output: "",
  outputOffset: 0,
  error: null,
  createdAt: "",
  updatedAt: "",
  finishedAt: null,
  resultFiles: [],
  ...over,
});

describe("chat cost", () => {
  it("keeps only Anthropic and OpenAI models with per-token prices", () => {
    const prices = parsePriceList({
      "claude-opus-5-5": { litellm_provider: "anthropic", input_cost_per_token: 4e-6, output_cost_per_token: 2e-5 },
      "gpt-6-sol": { litellm_provider: "openai", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
      "us.anthropic.claude-opus-5-5": { litellm_provider: "bedrock_converse", input_cost_per_token: 1, output_cost_per_token: 1 },
      sample_spec: { litellm_provider: "openai" },
    });
    expect(Object.keys(prices).sort()).toEqual(["claude-opus-5-5", "gpt-6-sol"]);
  });

  it("resolves Claude aliases, the default model and dated ids", () => {
    expect(priceFor(BUILTIN_PRICES, { agent: "claude", options: { model: "sonnet" } })).toBe(BUILTIN_PRICES["claude-sonnet-5-5"]);
    expect(priceFor(BUILTIN_PRICES, { agent: "claude", options: {} })).toBe(BUILTIN_PRICES["claude-opus-5-5"]);
    expect(priceFor(BUILTIN_PRICES, { agent: "claude", options: { model: "claude-opus-5-5[1m]" } })).toBe(BUILTIN_PRICES["claude-opus-5-5"]);
    const prices = { "gpt-6-sol": { input: 1, output: 2 } };
    expect(priceFor(prices, { agent: "codex", options: { model: "gpt-6-sol-2026-05-01" } })).toBe(prices["gpt-6-sol"]);
    expect(priceFor(prices, { agent: "codex", options: {} })).toBeNull();
  });

  it("counts earlier turns as input, since the API resends the history", () => {
    const turns = [
      turn({ question: "a".repeat(40), output: "b".repeat(400) }),
      turn({ turn: 2, question: "c".repeat(40), output: "d".repeat(80), context: { scope: "section", sectionIds: [], label: "", bytes: 0, tokens: 500 } }),
    ];
    expect(turnTokens(turns, 1)).toEqual({ input: 10 + 100 + 10 + 500, output: 20 });
    const cost = turnCost(turns, 1, { input: 1e-6, output: 1e-5 })!;
    expect(cost.input).toBeCloseTo(620e-6);
    expect(cost.total).toBeCloseTo(620e-6 + 20e-5);
    expect(turnCost(turns, 1, null)).toBeNull();
  });

  it("formats small amounts with enough digits", () => {
    expect(formatUsd(0.00042)).toBe("$0.0004");
    expect(formatUsd(0.1234)).toBe("$0.123");
    expect(formatUsd(12.4)).toBe("$12.40");
  });
});
