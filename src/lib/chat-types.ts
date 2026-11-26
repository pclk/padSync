// Chat threads (docs/chat-panel-2026-11-17.md): shared by the API routes, the client wrapper
// (src/lib/chat-api.ts) and the side panel. Each turn is one `jobs` row with kind "chat".

export type ChatAgent = "claude" | "codex";
export type TurnStatus = "uploading" | "queued" | "running" | "done" | "error" | "cancelled";

export interface ChatOptions {
  model?: string;
  effort?: string;
  webSearch?: boolean;
  allowEdits?: boolean;
  allowCode?: boolean;
  /** Which login on the Mac runs it, such as "claude_work" or "codex_work". */
  account?: string;
}

/** A model one of the Mac's logins can run (bridge/catalog.ts sends these). */
export interface CatalogModel {
  id: string;
  label: string;
  description?: string;
  badge?: string;
  /** Older or less common: listed under "More models". */
  more?: boolean;
  efforts: string[];
  defaultEffort?: string;
  contextWindow?: number;
}

export interface CatalogAccount {
  /** "claude", or a Codex home's name ("codex", "codex_work"). */
  id: string;
  agent: ChatAgent;
  label: string;
  /** e.g. "you@example.com · Plus" */
  detail?: string;
  defaultModel?: string;
  defaultEffort?: string;
  models: CatalogModel[];
}

export interface CatalogResponse {
  /** null until a bridge has sent one (older bridges never do). */
  accounts: CatalogAccount[] | null;
  updatedAt: string | null;
}

/** What a turn sent from the notebook, for the chip on the user message. */
export interface ContextSummary {
  scope: "none" | "section" | "sections" | "selection" | "notebook";
  sectionIds: string[];
  label: string;
  bytes: number;
  tokens: number;
}

export interface FileInfo {
  path: string;
  mime: string;
  size: number;
}

export interface ThreadSummary {
  id: string;
  /** "" when the thread is not tied to a notebook. */
  notebookId: string;
  title: string;
  agent: ChatAgent;
  options: ChatOptions;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  turnCount: number;
  lastStatus: TurnStatus | null;
  /** Start of the last reply (or question), one line. */
  preview: string;
  forkedFrom: { threadId: string; turn: number } | null;
}

export interface Turn {
  jobId: string;
  turn: number;
  question: string;
  context: ContextSummary | null;
  attachments: FileInfo[];
  /** Latency stamps, epoch ms per machine (src/lib/chat-trace.ts). */
  trace?: Record<string, number>;
  agent: ChatAgent;
  options: ChatOptions;
  status: TurnStatus;
  /** Reply text starting at `outputOffset` (0 unless the request asked for a delta). */
  output: string;
  outputOffset: number;
  /** The agent's thinking, and text it wrote before using a tool, from `thinkingOffset` on. */
  thinking?: string;
  thinkingOffset?: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  resultFiles: FileInfo[];
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
  bridgeSeenAt: string | null;
}

export interface ThreadResponse {
  thread: ThreadSummary;
  /** Only turns updated after `since`, when it was given. */
  turns: Turn[];
  bridgeSeenAt: string | null;
  /** Server time; pass it back as `since` on the next poll. */
  now: string;
  /** Server clock (epoch ms) just before responding, for latency traces. */
  serverTime?: number;
}

export interface NewThread {
  notebookId: string;
  agent: ChatAgent;
  options: ChatOptions;
  title?: string;
}

export interface ThreadPatch {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  agent?: ChatAgent;
  options?: ChatOptions;
}

/** `files` and `uploads` have the same shape and limits as an ask job (src/server/jobs.ts). */
export interface NewTurn<F = unknown, U = unknown> {
  question: string;
  files: F[];
  uploads: U[];
  context?: ContextSummary;
  options?: ChatOptions;
  /** The device's own latency stamps from before the request ("client.*"). */
  trace?: Record<string, number>;
}

/** Layout of the Mac side panel (src/lib/layout-mode.ts decides it). */
export type PanelMode = "drawing" | "chat";
