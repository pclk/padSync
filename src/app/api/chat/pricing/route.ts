import type { NextRequest } from "next/server";
import { requireSession } from "@/server/guard";
import { BUILTIN_PRICES, parsePriceList, type PricingResponse } from "@/lib/chat-cost";

// LiteLLM keeps a public list of per-token API prices for Anthropic and OpenAI models.
const PRICE_LIST = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const FRESH_MS = 12 * 60 * 60_000;

// One copy per server instance; the list is ~5 MB, too big for the fetch cache.
let cached: PricingResponse | null = null;
let cachedAt = 0;

async function load(): Promise<PricingResponse> {
  if (cached && Date.now() - cachedAt < FRESH_MS) return cached;
  try {
    const res = await fetch(PRICE_LIST, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`price list: ${res.status}`);
    const prices = parsePriceList(await res.json());
    if (!Object.keys(prices).length) throw new Error("price list: no models");
    cached = { prices: { ...BUILTIN_PRICES, ...prices }, source: "pulled", updatedAt: new Date().toISOString() };
    cachedAt = Date.now();
    return cached;
  } catch {
    // Keep the last good copy; failing that, the shipped Claude prices.
    return cached ?? { prices: BUILTIN_PRICES, source: "builtin", updatedAt: new Date().toISOString() };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (auth instanceof Response) {
    auth.headers.set("Cache-Control", "no-store");
    return auth;
  }
  return Response.json(await load(), { headers: { "Cache-Control": "private, max-age=3600" } });
}
