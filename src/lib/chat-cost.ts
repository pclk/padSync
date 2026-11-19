// What a chat turn would cost if it were sent straight to the provider's API instead of through
// the Mac's subscription CLI. Prices come from /api/chat/pricing (pulled from a public price list);
// token counts are estimates (~4 characters a token), so the numbers are a guide, not a bill.
import type { ChatAgent, ChatOptions, Turn } from "./chat-types";

/** US dollars per token. */
export interface Price {
  input: number;
  output: number;
}

export interface PricingResponse {
  prices: Record<string, Price>;
  /** "pulled" when the public list was reachable, else the shipped Claude prices. */
  source: "pulled" | "builtin";
  updatedAt: string;
}

/** Anthropic API list prices, for when the public list cannot be fetched. */
export const BUILTIN_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10e-6, output: 50e-6 },
  "claude-fable-5": { input: 10e-6, output: 50e-6 },
  "claude-opus-5-5": { input: 4e-6, output: 20e-6 },
  "claude-opus-5": { input: 5e-6, output: 25e-6 },
  "claude-opus-4-8": { input: 5e-6, output: 25e-6 },
  "claude-opus-4-7": { input: 5e-6, output: 25e-6 },
  "claude-sonnet-5-5": { input: 2e-6, output: 10e-6 },
  "claude-sonnet-5": { input: 2e-6, output: 10e-6 },
  "claude-sonnet-4-6": { input: 3e-6, output: 15e-6 },
  "claude-haiku-5-5": { input: 0.1e-6, output: 0.5e-6 },
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6 },
};

/** Claude Code's short names, and what an unset model runs. */
const CLAUDE_ALIASES: Record<string, string> = {
  "": "claude-opus-5-5",
  default: "claude-opus-5-5",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

/** Keeps the chat models of one provider from LiteLLM's model_prices_and_context_window.json. */
export function parsePriceList(raw: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object" || !["anthropic", "openai"].includes(v.litellm_provider as string)) continue;
    const input = v.input_cost_per_token;
    const output = v.output_cost_per_token;
    if (typeof input === "number" && typeof output === "number" && input >= 0 && output >= 0)
      out[id] = { input, output };
  }
  return out;
}

/** The price of the model a turn ran on, or null when the list does not know it. */
export function priceFor(
  prices: Record<string, Price>,
  s: { agent: ChatAgent; options: ChatOptions },
  defaultModel?: string,
): Price | null {
  let id = (s.options.model || defaultModel || "").toLowerCase().replace(/\[.*\]$/, "");
  if (s.agent === "claude") id = CLAUDE_ALIASES[id] ?? id;
  if (!id) return null;
  if (prices[id]) return prices[id];
  // Dated or suffixed ids ("gpt-6-sol-2026-05-01") fall back to the shortest known prefix.
  const parts = id.split("-");
  for (let n = parts.length - 1; n > 1; n--) {
    const hit = prices[parts.slice(0, n).join("-")];
    if (hit) return hit;
  }
  return null;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** An image is ~1,600 tokens; a PDF roughly one page of text per 50 KB; anything else is text. */
function attachmentTokens(a: { mime: string; size: number }) {
  if (a.mime.startsWith("audio/")) return 0; // a voice message arrives as its transcript, in the question
  if (a.mime.startsWith("image/")) return 1600;
  if (a.mime === "application/pdf") return Math.ceil(a.size / 50_000) * 800;
  return Math.ceil(a.size / 4);
}

/**
 * Tokens the turn at `index` would send and get back. The API is stateless, so the input
 * includes every earlier question and reply in the thread.
 */
export function turnTokens(turns: Turn[], index: number) {
  const t = turns[index];
  const history = turns
    .slice(0, index)
    .reduce((n, p) => n + estimateTokens(p.question) + estimateTokens(p.output) + (p.context?.tokens ?? 0), 0);
  const input =
    history +
    estimateTokens(t.question) +
    (t.context?.tokens ?? 0) +
    t.attachments.reduce((n, a) => n + attachmentTokens(a), 0);
  return { input, output: estimateTokens(t.output) };
}

export function turnCost(turns: Turn[], index: number, price: Price | null) {
  if (!price) return null;
  const tokens = turnTokens(turns, index);
  const input = tokens.input * price.input;
  return { tokens, input, total: input + tokens.output * price.output };
}

/** "$0.0042", "$0.13", "$12.40": enough digits that small turns do not all read $0.00. */
export function formatUsd(n: number) {
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
