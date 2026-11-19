// Ready-made chat prompts for the iPad's prompt menu, edited in the toolbar settings, and the
// hand-off that gets a picked prompt to the chat composer (which may not be mounted yet).
import type { IconName } from "@/components/Icons";
import type { ContextSummary } from "./chat-types";

/** What a prompt sends from the notebook: the chat's own choice, or one of its scopes. */
export type PromptContext = "chat" | Exclude<ContextSummary["scope"], "sections">;
export const PROMPT_CONTEXTS: { value: PromptContext; label: string }[] = [
  { value: "chat", label: "As set in the chat" },
  { value: "section", label: "This page" },
  { value: "selection", label: "Lasso selection" },
  { value: "notebook", label: "Whole notebook" },
  { value: "none", label: "Nothing" },
];

export interface ChatPrompt {
  id: string;
  label: string;
  text: string;
  /** Send at once; otherwise it goes into the chat box to be finished first. */
  send: boolean;
  /** Record a voice message first, sent with the text (which may be empty). */
  voice: boolean;
  context: PromptContext;
  icon: IconName;
}

export const PROMPTS_KEY = "padsync.prompts";
export const MAX_PROMPTS = 8;
export const PROMPT_ICONS: readonly IconName[] = ["check", "bulb", "help", "sparkles", "list", "search", "edit", "layers", "code", "message", "mic"];

const starter = (p: Pick<ChatPrompt, "id" | "label" | "icon" | "text"> & Partial<ChatPrompt>): ChatPrompt => ({ send: true, voice: false, context: "chat", ...p });

export const DEFAULT_PROMPTS: ChatPrompt[] = [
  starter({ id: "check", label: "Check my work", icon: "check", text: "Check my working on this page. Point out each mistake and where it is, but don't give me the full answer." }),
  starter({ id: "hint", label: "Hint", icon: "bulb", text: "Give me a hint for the next step on this page, without solving it." }),
  starter({ id: "explain", label: "Explain", icon: "help", text: "Explain the idea behind this question step by step, as if I'm seeing it for the first time." }),
  starter({ id: "solve", label: "Solve", icon: "sparkles", text: "Solve this question fully, showing every step and why it follows." }),
  starter({ id: "summary", label: "Summarise", icon: "list", text: "Summarise my notes on this page into the key points." }),
  starter({ id: "voice", label: "Voice message", icon: "mic", voice: true, text: "" }),
  starter({ id: "ask", label: "Ask…", icon: "message", send: false, text: "About this page: " }),
];

const isIcon = (v: unknown): v is IconName => PROMPT_ICONS.includes(v as IconName);
const isContext = (v: unknown): v is PromptContext => PROMPT_CONTEXTS.some((c) => c.value === v);

/** Stored prompts made whole: bad entries dropped, missing fields filled, at most MAX_PROMPTS. */
export function normalizePrompts(raw: unknown): ChatPrompt[] {
  if (!Array.isArray(raw)) return DEFAULT_PROMPTS;
  const seen = new Set<string>();
  const out: ChatPrompt[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const p = r as Partial<ChatPrompt>;
    if (typeof p.id !== "string" || seen.has(p.id) || typeof p.text !== "string") continue;
    // A voice prompt is sent once the recording ends, so it never waits in the chat box.
    const voice = p.voice === true;
    seen.add(p.id);
    out.push({
      id: p.id,
      label: typeof p.label === "string" && p.label.trim() ? p.label : "Prompt",
      text: p.text,
      send: voice || p.send !== false,
      voice,
      context: isContext(p.context) ? p.context : "chat",
      icon: isIcon(p.icon) ? p.icon : "message",
    });
  }
  return out.slice(0, MAX_PROMPTS);
}

export const newPrompt = (): ChatPrompt => starter({ id: `p${Date.now().toString(36)}`, label: "New prompt", icon: "message", text: "" });

// --- hand-off to the chat --------------------------------------------------------------------
// The menu opens the side panel and queues the prompt; the composer takes it once it is mounted
// and its chat has loaded, so a prompt picked with the panel closed still arrives.

export const PROMPT_EVENT = "padsync:prompt";

/** A prompt on its way to the chat, with its voice message when it recorded one. */
export interface QueuedPrompt {
  prompt: ChatPrompt;
  audio?: Blob;
}
let queued: QueuedPrompt | null = null;

export function queuePrompt(prompt: ChatPrompt, audio?: Blob) {
  queued = { prompt, ...(audio ? { audio } : {}) };
  window.dispatchEvent(new Event(PROMPT_EVENT));
}

/** The queued prompt, if any, left in place (the composer may have to wait to send it). */
export const peekPrompt = () => queued;

/** The queued prompt, if any, removing it so only one composer acts on it. */
export function takePrompt() {
  const p = queued;
  queued = null;
  return p;
}
