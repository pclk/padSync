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
  agent: ChatAgent;
  options: ChatOptions;
  status: TurnStatus;
  /** Reply text starting at `outputOffset` (0 unless the request asked for a delta). */
  output: string;
  outputOffset: number;
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
}

/** Layout of the Mac side panel (src/lib/layout-mode.ts decides it). */
export type PanelMode = "drawing" | "chat";
