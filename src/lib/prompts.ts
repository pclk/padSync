// Ready-made chat prompts for the iPad's prompt menu, edited in the toolbar settings, and the
// hand-off that gets a picked prompt to the chat composer (which may not be mounted yet).
import type { IconName } from "@/components/Icons";

export interface ChatPrompt {
  id: string;
  label: string;
  text: string;
  /** Send at once; otherwise it goes into the chat box to be finished first. */
  send: boolean;
  icon: IconName;
}

export const PROMPTS_KEY = "padsync.prompts";
export const MAX_PROMPTS = 8;
export const PROMPT_ICONS: readonly IconName[] = ["check", "bulb", "help", "sparkles", "list", "search", "edit", "layers", "code", "message"];

export const DEFAULT_PROMPTS: ChatPrompt[] = [
  { id: "check", label: "Check my work", icon: "check", send: true, text: "Check my working on this page. Point out each mistake and where it is, but don't give me the full answer." },
  { id: "hint", label: "Hint", icon: "bulb", send: true, text: "Give me a hint for the next step on this page, without solving it." },
  { id: "explain", label: "Explain", icon: "help", send: true, text: "Explain the idea behind this question step by step, as if I'm seeing it for the first time." },
  { id: "solve", label: "Solve", icon: "sparkles", send: true, text: "Solve this question fully, showing every step and why it follows." },
  { id: "summary", label: "Summarise", icon: "list", send: true, text: "Summarise my notes on this page into the key points." },
  { id: "ask", label: "Ask…", icon: "message", send: false, text: "About this page: " },
];

const isIcon = (v: unknown): v is IconName => PROMPT_ICONS.includes(v as IconName);

/** Stored prompts made whole: bad entries dropped, missing fields filled, at most MAX_PROMPTS. */
export function normalizePrompts(raw: unknown): ChatPrompt[] {
  if (!Array.isArray(raw)) return DEFAULT_PROMPTS;
  const seen = new Set<string>();
  const out: ChatPrompt[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const p = r as Partial<ChatPrompt>;
    if (typeof p.id !== "string" || seen.has(p.id) || typeof p.text !== "string") continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      label: typeof p.label === "string" && p.label.trim() ? p.label : "Prompt",
      text: p.text,
      send: p.send !== false,
      icon: isIcon(p.icon) ? p.icon : "message",
    });
  }
  return out.slice(0, MAX_PROMPTS);
}

export const newPrompt = (): ChatPrompt => ({ id: `p${Date.now().toString(36)}`, label: "New prompt", text: "", send: true, icon: "message" });

// --- hand-off to the chat --------------------------------------------------------------------
// The menu opens the side panel and queues the prompt; the composer takes it once it is mounted
// and its chat has loaded, so a prompt picked with the panel closed still arrives.

export const PROMPT_EVENT = "padsync:prompt";
let queued: ChatPrompt | null = null;

export function queuePrompt(p: ChatPrompt) {
  queued = p;
  window.dispatchEvent(new Event(PROMPT_EVENT));
}

/** The queued prompt, if any, removing it so only one composer acts on it. */
export function takePrompt() {
  const p = queued;
  queued = null;
  return p;
}
