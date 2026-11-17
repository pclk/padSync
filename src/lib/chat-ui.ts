import {
  MAX_UPLOAD_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "@/lib/uploads";
import type { ThreadSummary, Turn } from "@/lib/chat-types";

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
export const pollDelay = (kind: "list" | "thread", active: boolean) =>
  kind === "list" ? 30_000 : active ? 1500 : 15_000;
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
    inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped || inFlight || !visible()) return;
    inFlight = true;
    try {
      await request();
    } finally {
      inFlight = false;
      if (!stopped && visible())
        timer = timers.set(() => {
          void tick();
        }, delay());
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
