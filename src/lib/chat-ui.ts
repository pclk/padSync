import {
  MAX_UPLOAD_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/uploads";
import type { CatalogAccount, ChatAgent, ChatOptions, ThreadSummary, Turn } from "@/lib/chat-types";

export type ThreadFilter = "notebook" | "all" | "archived";
export function sortThreads(threads: ThreadSummary[]) {
  return [...threads].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastMessageAt ?? b.updatedAt).localeCompare(
        a.lastMessageAt ?? a.updatedAt,
      ) ||
      a.id.localeCompare(b.id),
  );
}
export function groupThreads(
  threads: ThreadSummary[],
  filter: ThreadFilter,
  notebookId: string,
) {
  return sortThreads(
    threads.filter((t) =>
      filter === "archived"
        ? t.archived
        : !t.archived && (filter === "all" || t.notebookId === notebookId),
    ),
  );
}
export const isUnread = (thread: ThreadSummary, seen: Record<string, string>) =>
  !!thread.turnCount &&
  (!seen[thread.id] || thread.updatedAt > seen[thread.id]);
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function readStored<T>(
  key: string,
  fallback: T,
  storage?: StorageLike,
): T {
  try {
    return (
      JSON.parse((storage ?? localStorage).getItem(key) ?? "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function writeStored(
  key: string,
  value: unknown,
  storage?: StorageLike,
) {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(value));
  } catch {}
}
export const readDraft = (id: string, storage?: StorageLike) =>
  readStored(`padsync.chat.draft.${id}`, "", storage);
export const writeDraft = (id: string, value: string, storage?: StorageLike) =>
  writeStored(`padsync.chat.draft.${id}`, value, storage);
export function composerAction(
  e: {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
  },
  empty: boolean,
) {
  if (e.isComposing) return "none";
  if (e.key === "Escape" && empty) return "stop";
  if (e.key === "Enter" && (e.metaKey || !e.shiftKey)) return "send";
  return "none";
}
export function exportMarkdown(thread: ThreadSummary, turns: Turn[]) {
  return (
    `# ${thread.title || "Untitled thread"}\n\n` +
    turns
      .map(
        (t) =>
          `## You\n\n${t.question}\n\n${t.context ? `Context: ${t.context.label}\n\n` : ""}${t.attachments.map((a) => `Attachment: ${a.path}`).join("\n")}\n\n## ${t.agent} · ${[t.options.model, t.options.effort, t.status].filter(Boolean).join(" · ")}\n\n${t.output}${t.error ? `\n\nError: ${t.error}` : ""}`,
      )
      .join("\n\n")
  );
}
/** With a live query (src/lib/live-query.ts) waking the open chat, polling is only a backup. */
export const pollDelay = (kind: "list" | "thread", active: boolean, live = false) =>
  kind === "list" ? 30_000 : live ? (active ? 3000 : 30_000) : active ? 600 : 15_000;
/** A completion-scheduled timer owns one request; visibility changes invalidate scheduled work. */
export function createPollScheduler(
  request: () => Promise<unknown>,
  delay: () => number,
  visible: () => boolean,
  timers = {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
) {
  let stopped = false,
    inFlight = false,
    // A refresh asked for while a request was in flight: run again as soon as it ends, since
    // whatever prompted it may have happened after that request read its data.
    again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || !visible()) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    try {
      await request();
    } finally {
      inFlight = false;
      if (!stopped && visible())
        timer = timers.set(() => {
          void tick();
        }, again ? 0 : delay());
      again = false;
    }
  };
  return {
    refresh() {
      if (timer) timers.clear(timer);
      timer = undefined;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) timers.clear(timer);
    },
  };
}

export const MODELS = {
  claude: [
    ["", "Default model"],
    ["fable", "Fable"],
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
    ["haiku", "Haiku"],
  ],
  codex: [
    ["", "Default model"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ],
};
export const EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};
export function hasNewOutput(previous: Turn[], next: Turn[]) {
  return next.some(
    (t) =>
      t.output.length >
      (previous.find((old) => old.jobId === t.jobId)?.output.length ?? 0),
  );
}
export function queuedAfterPrevious(turn: Turn, turns: Turn[]) {
  return (
    turn.status === "queued" &&
    turns.some(
      (t) =>
        t.turn < turn.turn &&
        ["uploading", "queued", "running"].includes(t.status),
    )
  );
}
export function relativeTime(at: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
export function editNeedsFork(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 409
  );
}

export function validateAttachments(
  files: { name: string; size: number; type: string }[],
) {
  if (files.length > MAX_UPLOAD_FILES)
    return `Choose at most ${MAX_UPLOAD_FILES} files.`;
  for (const file of files) {
    if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(file.type))
      return `${file.name}: choose an image or PDF.`;
    if (file.size > MAX_FILE_BYTES)
      return `${file.name}: maximum size is 25 MB.`;
    if (!file.size) return `${file.name}: file is empty.`;
  }
  return files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES
    ? "Attachments must total at most 40 MB."
    : null;
}

// ---------------------------------------------------------------------------------------------
// Model picker, thread list and context defaults (docs/chat-revamp-2026-11-18.md)

/** The built-in choices, for when no bridge has sent its catalog yet. */
export function fallbackCatalog(): CatalogAccount[] {
  return (["claude", "codex"] as const).map((agent) => ({
    id: agent,
    agent,
    label: agent === "claude" ? "Claude" : "Codex",
    models: MODELS[agent]
      .filter(([id]) => id)
      .map(([id, label]) => ({ id, label, efforts: EFFORTS[agent] })),
  }));
}

/** The account a thread runs on: its named login, else the agent's default one. */
export function accountFor(
  accounts: CatalogAccount[],
  s: { agent: ChatAgent; options: ChatOptions },
) {
  const mine = accounts.filter((a) => a.agent === s.agent);
  return (
    mine.find((a) => a.id === s.options.account) ??
    (s.agent === "codex" && s.options.account
      ? undefined
      : (mine.find((a) => a.id === s.agent) ?? mine[0]))
  );
}

/** What the picker shows for a thread's (or turn's) settings. */
export function describeModel(
  accounts: CatalogAccount[],
  s: { agent: ChatAgent; options: ChatOptions },
) {
  const account = accountFor(accounts, s);
  const id = s.options.model || account?.defaultModel;
  const model = account?.models.find((m) => m.id === id);
  const label = model?.label ?? s.options.model ?? (s.agent === "claude" ? "Claude" : "Codex");
  const effort = s.options.effort || undefined;
  return { account, model, label, effort };
}

/** Settings after picking `model` on `account`: an effort the new model lacks is dropped. */
export function chooseModel(
  options: ChatOptions,
  account: Pick<CatalogAccount, "id" | "agent">,
  model: { id: string; efforts?: string[] },
): { agent: ChatAgent; options: ChatOptions } {
  const keepEffort =
    options.effort && (!model.efforts || model.efforts.includes(options.effort));
  return {
    agent: account.agent,
    options: {
      ...options,
      model: model.id,
      account: account.agent === "codex" ? account.id : undefined,
      effort: keepEffort ? options.effort : undefined,
    },
  };
}

/** Case-insensitive match on model label, id, description and account. */
export function filterModels(accounts: CatalogAccount[], q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return accounts;
  return accounts
    .map((a) => ({
      ...a,
      models: a.models.filter((m) => {
        const hay = `${m.label} ${m.id} ${m.description ?? ""} ${a.label} ${a.detail ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((a) => a.models.length);
}

/** Web search and code are on unless the thread turned them off. */
export const toolsOf = (o: ChatOptions) => ({
  webSearch: o.webSearch !== false,
  allowCode: o.allowCode !== false,
});

/** The synced default for new chats (src/server/prefs.ts "chat.defaultModel"): no tools, just the model. */
export interface ModelChoice {
  agent: ChatAgent;
  options: Pick<ChatOptions, "model" | "effort" | "account">;
}
export const modelChoice = (s: { agent: ChatAgent; options: ChatOptions }): ModelChoice => ({
  agent: s.agent,
  options: Object.fromEntries(
    (["model", "effort", "account"] as const).flatMap((k) => (s.options[k] ? [[k, s.options[k]]] : [])),
  ),
});
export const sameModel = (a: { agent: ChatAgent; options: ChatOptions }, b: { agent: ChatAgent; options: ChatOptions } | null) =>
  !!b && JSON.stringify(modelChoice(a)) === JSON.stringify(modelChoice(b));
/**
 * Settings a new chat starts with: the synced default model (when one is set) with the tools
 * last used on this device; otherwise whatever was last picked here.
 */
export function newChatSettings(
  lastUsed: { agent: ChatAgent; options: ChatOptions },
  defaultModel: ModelChoice | null,
): { agent: ChatAgent; options: ChatOptions } {
  if (!defaultModel) return lastUsed;
  const tools = { webSearch: lastUsed.options.webSearch, allowEdits: lastUsed.options.allowEdits, allowCode: lastUsed.options.allowCode };
  const set = Object.fromEntries(Object.entries(tools).filter(([, v]) => v !== undefined));
  return { agent: defaultModel.agent, options: { ...set, ...defaultModel.options } };
}

/** An untouched thread "New chat" should reuse instead of making another empty one. */
export function reusableThread(
  threads: ThreadSummary[],
  notebookId: string,
  current?: { id: string; turns: number },
) {
  const empty = (t: ThreadSummary) =>
    t.turnCount === 0 &&
    !t.archived &&
    t.notebookId === notebookId &&
    !(current && t.id === current.id && current.turns > 0);
  return (
    threads.find((t) => current && t.id === current.id && empty(t)) ??
    threads.find(empty) ??
    null
  );
}

export type DateGroup = "Pinned" | "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";
/** Sidebar sections by last activity, in local days. */
export function dateGroup(thread: ThreadSummary, now: number): DateGroup {
  if (thread.pinned) return "Pinned";
  const at = new Date(thread.lastMessageAt ?? thread.updatedAt);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Previous 7 days" : days < 30 ? "Previous 30 days" : "Older";
}

/** The section the context means by "this section": where the iPad is, else the Mac's own. */
export function focusedSection<S extends { id: string }>(
  sections: S[],
  current: S | null,
  ipad: { notebookId: string; sectionId: string | null } | null,
  notebookId: string,
): { section: S | null; fromIpad: boolean } {
  const there =
    ipad && ipad.notebookId === notebookId
      ? sections.find((s) => s.id === ipad.sectionId)
      : undefined;
  return there ? { section: there, fromIpad: true } : { section: current, fromIpad: false };
}
