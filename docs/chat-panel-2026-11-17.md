# Adaptive layout + chat panel (2026-11-17)

## Goal

On the Mac, the notebook (drawing area) and the side panel share the screen according to what is
happening on the iPad:

- **Activity** (edits are arriving from another device): the drawing area takes the screen, the
  side panel shrinks to its compact width (360 px) and stays usable.
- **No activity** for `idleMs`: the drawing area shrinks and the side panel takes **half the
  screen**, with a full chat client in it.

The chat replaces the one-shot, per-section "Ask AI" with multi-turn **threads** that are complete
enough that the user never needs another chat app: many threads, history, streaming, editing,
regenerating, attachments, context from the notebook, model choice, search, export.

The iPad layout does not change (panel hidden by default, toggle still works).

## 1. Adaptive layout

### Activity signal

`src/lib/activity.ts` (contract below) is a tiny event bus.

- **Remote edits**: when sync applies pulled entities, `src/lib/sync.ts` calls
  `emitActivity({ notebookId, source: "remote", kinds, at })` once per applied batch, for entities
  of kind ink / text / section (and their deletes) whose `hlc` device suffix is not this device.
  Presence entities never count (scrolling is not editing).
- **Local edits**: the ink controller and the text/section editors on this device emit
  `source: "local"` (the Mac user drawing or typing also needs the canvas).
- Only events for the open notebook count.

### State machine (`src/lib/layout-mode.ts`, pure, unit-tested)

```
mode:      "auto" | "drawing" | "chat"        (user choice, persisted per device)
effective: "drawing" | "chat"                 (what is rendered)

auto:
  activity event            -> effective = drawing, restart idle timer
  idle timer fires (idleMs) -> effective = chat
  initial                   -> chat if no activity in the last idleMs, else drawing
drawing / chat: fixed, ignore activity (a manual pick holds until "Auto" is chosen again)
```

- `idleMs` default **15 s**, Settings slider 5–120 s.
- Hysteresis: once in drawing, stay at least `minDrawingMs` = 4 s, so one stray sync batch
  does not make the layout flicker.
- No automatic switch to chat while the ink controller reports `isDrawing()` on this device.
- While the composer has focus, an automatic switch to drawing still happens (the user asked for
  this), but the composer keeps focus, caret and draft, and stays visible in compact width.
- The reducer takes `now` as input (no timers inside), so tests use plain numbers. A small hook
  (`useLayoutMode`) owns the timer.

### Rendering

- Panel width: drawing = 360 px; chat = `max(420px, 50vw)`, never more than `100vw - 480px`.
- The width changes with a 250 ms CSS transition (none under `prefers-reduced-motion`). The
  notebook zoom (`fitZoom`) is recomputed once the transition ends (`transitionend`, with a
  timeout fallback), not on every frame.
- Keep the reading position when resizing: note the section and offset at the top of the
  viewport before the change and scroll back to it after the zoom changes (same approach as Follow
  iPad).
- Toolbar control: a three-way **Auto / Drawing / Chat** toggle, with a small dot that shows the
  current effective mode in Auto.
- Settings → Layout: idle delay slider, "Start in Auto" default.

## 2. Chat

### Data model (server, `src/server/db.ts` migration, same style as `jobs`)

```sql
create table if not exists chat_threads (
  id text primary key,
  notebook_id text not null default '',        -- '' = not tied to a notebook
  title text not null default '',
  agent text not null,                         -- 'claude' | 'codex'
  options jsonb not null default '{}'::jsonb,  -- JobOptions: model, effort, webSearch, allowEdits, allowCode
  pinned boolean not null default false,
  archived boolean not null default false,
  agent_session jsonb,                         -- { agent, sessionId } written by the bridge
  forked_from jsonb,                           -- { threadId, turn } when made with "edit & resend"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  deleted_at timestamptz
);
alter table jobs add column if not exists thread_id text;
alter table jobs add column if not exists turn integer;
create unique index if not exists jobs_thread_turn_idx on jobs (thread_id, turn) where thread_id is not null;
create index if not exists chat_threads_list_idx on chat_threads (deleted_at, archived, last_message_at desc);
```

Each **turn** is one `jobs` row with `kind = 'chat'`, `thread_id` and `turn` set: `question` is the
user message, `output` the assistant reply. Results (`result_files`), cancel, upload parts and
heartbeats all reuse the job machinery.

- `kind = 'chat'` is a new job kind, claimed only by bridges that send the feature `"chat"`
  (add to `BRIDGE_FEATURES`). Old bridges never see chat jobs.
- **Turn order**: the claim query only takes a chat job if no earlier turn of the same thread is
  `uploading`, `queued` or `running`. The user can send while a reply is streaming; the new turn
  waits for the previous one.
- An earlier turn that ends in `error` or `cancelled` does not block later turns.
- Deleting a thread is a soft delete (`deleted_at`) and cancels its queued/running turns.
- Legacy per-section ask jobs (`thread_id is null`) stay as they are and are listed read-only under
  "Earlier questions" in the Section tab.

### API (all `requireSession`, JSON, `Cache-Control: no-store`)

| Method + path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/chat/threads` | `?notebookId=` (optional, `''` = general), `?q=` (search titles and turn text, ILIKE, at most 50), `?archived=1` | `{ threads: ThreadSummary[], bridgeSeenAt }` |
| `POST /api/chat/threads` | `{ notebookId, agent, options, title? }` | `{ thread }` |
| `PATCH /api/chat/threads/[id]` | `{ title?, pinned?, archived?, agent?, options? }` | `{ thread }` |
| `DELETE /api/chat/threads/[id]` | | `{ ok: true }` (soft delete, cancels running turns) |
| `GET /api/chat/threads/[id]` | `?since=<iso>` and `?from=<turn>:<outputLength>,…` | `{ thread, turns: Turn[], bridgeSeenAt, now }`: only turns updated after `since`; for a running turn listed in `from`, `output` holds only the text after that length (`outputOffset` says where it starts), so polling while streaming moves the new text only |
| `POST /api/chat/threads/[id]/turns` | `{ question, files, uploads, context?: ContextSummary, options? }` | `{ turn }` (queued; `uploads` reuse `/api/jobs/[id]/inputs`) |
| `POST /api/chat/threads/[id]/turns/[turn]/regenerate` | | `{ turn }`: a new turn with the same question and attachments (only for the last turn) |
| `POST /api/chat/threads/[id]/fork` | `{ uptoTurn, title? }` | `{ thread }`: copies turns ≤ `uptoTurn` (done ones only) into a new thread, `forked_from` set, no `agent_session` |
| `POST /api/jobs/[id]/cancel` | | existing |

Title: if empty, the server sets it from the first question (first line, ≤ 60 chars) when turn 1 is
created. The user can rename it at any time.

### Bridge (`bridge/`)

For a chat job the bridge gets, besides the usual bundle files, `thread` (agent, `agent_session`)
and `history` (earlier done turns: question + output, newest last).

1. **Resume** when `agent_session.agent === job.agent`:
   Claude: `claude -p --resume <sessionId> …`; Codex: `codex exec resume <sessionId> --json …`.
   The prompt then holds only the new message and the paths of this turn's files.
2. **Otherwise, or when resume fails** with an unknown or expired session: write `history.md`
   (earlier turns, newest kept, cut at 60k characters with a note), say in the prompt that it is
   the conversation so far, and start a fresh session. Retry once, not more.
3. Capture the session id from the stream (Claude: `session_id` on the `system`/`init` and
   `result` events; Codex: `thread_id` on `thread.started`) and send it in the final update as
   `sessionId`. The server stores it in `chat_threads.agent_session`.
4. Before using any flag, check it against `claude --help`, `codex exec --help` and
   `codex exec resume --help` on this Mac. Don't rely on memory.
5. Chat prompts allow `out/` edits under the same rules as ask jobs (`allowEdits`), and the
   reply's returned files show up with the existing `ReturnedFiles` UI.

### Client contract (`src/lib/chat-types.ts`, shared by server and UI)

```ts
export type Agent = "claude" | "codex";
export type TurnStatus = "uploading" | "queued" | "running" | "done" | "error" | "cancelled";
export interface ChatOptions { model?: string; effort?: string; webSearch?: boolean; allowEdits?: boolean; allowCode?: boolean }
export interface ContextSummary { scope: "none" | "section" | "sections" | "selection" | "notebook"; sectionIds: string[]; label: string; bytes: number; tokens: number }
export interface ThreadSummary {
  id: string; notebookId: string; title: string; agent: Agent; options: ChatOptions;
  pinned: boolean; archived: boolean; createdAt: string; updatedAt: string; lastMessageAt: string | null;
  turnCount: number; lastStatus: TurnStatus | null; preview: string; forkedFrom: { threadId: string; turn: number } | null;
}
export interface Turn {
  jobId: string; turn: number; question: string; context: ContextSummary | null;
  attachments: { path: string; mime: string; size: number }[];
  agent: Agent; options: ChatOptions; status: TurnStatus;
  output: string; outputOffset: number; error: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
  resultFiles: { path: string; mime: string; size: number }[];
}
```

`src/lib/chat-api.ts` wraps every endpoint as typed functions with the same error mapping as
`AskPanel` (401 → sign in, 503 → no database, offline → "needs a connection").

### UI (side panel)

The panel has two tabs: **Chat** (default) and **Section**. The current panel content (Follow
iPad, section info and stats, copy image or text, solutions, reorder) moves unchanged into
Section, which also holds "Earlier questions".

**Chat mode (half screen)**: thread list on the left (240 px, collapsible), conversation on the
right.
**Drawing mode (360 px)**: no list; a thread switcher (dropdown with search) above the
conversation.

Thread list
- New thread (button and ⌥N). It inherits the agent and options of the last thread used.
- Search box (⌘K), debounced 250 ms, server search across titles and messages.
- Filter: This notebook / All / Archived. Pinned threads first, then by last message.
- Each row: title, one-line preview, relative time, running spinner, error dot, and an unread dot
  (stored per device: last seen `updatedAt` per thread).
- Row menu: Rename (inline), Pin/Unpin, Archive/Unarchive, Export as Markdown, Delete (with an
  undo toast for 5 s before the request is sent).

Conversation
- User and assistant messages. Replies go through `renderMarkdown` (KaTeX, code highlighting);
  each code block gets a copy button.
- Message header: agent, model, effort, time, status chip. A context chip on user messages ("3
  sections · 2 renders"), which opens the bundle preview.
- Streaming: text grows as it arrives; auto-scroll unless the user has scrolled up, in which case
  a "↓ New text" button appears.
- Actions: **Stop** (running or queued), **Retry** (error), **Regenerate** (last reply),
  **Edit & resend** (any user message: forks the thread up to the previous turn and sends the
  edited text in the new thread), **Copy** (message or whole thread as Markdown).
- Returned files: the existing `ReturnedFiles` component, inline under the reply.
- Status lines: "Waiting for the bridge on your Mac" (bridge offline), "Queued after the previous
  reply", signed out, no database, offline.
- Thread header: editable title, agent, model and effort selectors and a web search toggle (they
  apply to later turns and are saved on the thread), plus a menu with fork, export, archive and
  delete.

Composer
- Textarea that grows up to 40% of the panel height. Enter sends; Shift+Enter makes a new line;
  ⌘↵ also sends; Esc stops the running turn when the composer is empty.
- The draft is saved per thread on this device and survives reloads and layout switches.
- **Context picker** (chips above the textarea): None / This section (default) / Selection /
  Sections… / Whole notebook. It reuses `ContextControls`, `buildBundle`, `bundleSignature` and
  the preview/send consistency rule from `docs/context-control-2026-11-17.md`. The summary
  ("2 sections · ~4k tokens") is always visible.
- **Attachments**: paste or drop images and PDFs, or use a 📎 button. They go through the existing
  `uploads` path. Each one shows as a removable chip with name and size; limits come from
  `src/lib/uploads.ts`.
- You can send while a reply streams (the turn queues behind it).

Keyboard: ⌘K search, ⌥N new thread, ⌥↑/⌥↓ previous/next thread, `/` focus the composer
(when no input is focused). All controls are reachable by keyboard and have labels. Finished
replies are announced through `aria-live="polite"`.

### Polling and usage (keep Neon and Vercel costs flat)

- Poll only while the panel is visible and the tab is visible.
- Open thread: every 1.5 s while any turn is queued or running, using `since` and `from`, so each
  poll moves only the new text. Otherwise every 15 s with `since`, which usually returns no turns.
- Thread list: every 30 s, and right after any action on this device. Nothing runs while the tab
  is hidden.
- One request per tick. Never run several fetches for the same thread at once (skip a tick if the
  previous one is still in flight).

## 3. Tests

Server and bridge (pglite and existing helpers):
- Thread CRUD, soft delete cancels running turns, search over title and turn text, archived
  filter.
- Turn numbering under concurrent POSTs: unique, gap-free.
- Claim order: turn 2 is not claimed while turn 1 is queued or running; it is claimed after turn
  1 is done, errored or cancelled; an old bridge without `"chat"` never claims chat jobs.
- `since` and `from` return only changed turns and only the new output text.
- Regenerate only on the last turn; fork copies done turns ≤ N and never `agent_session`.
- Title from the first question.
- Bridge: resume arguments for both agents; session id parsed from sample stream lines; fallback to
  `history.md` when resume fails; history cut at 60k characters, newest kept.

Client (pure modules, no DOM library needed):
- `layout-mode` reducer: auto drawing↔chat with `idleMs`, `minDrawingMs` hysteresis, a manual pick
  holds, no switch to chat while drawing, initial state.
- Remote-edit detection: own-device hlc is ignored, presence is ignored, other notebooks are
  ignored.
- Chat UI helpers: thread sort and group (pinned, then recency), unread logic, draft
  storage, composer key handling (Enter, Shift+Enter, ⌘↵, Esc), streaming merge (`outputOffset`
  plus delta → full text, out-of-order or duplicate ticks ignored), Markdown export of a thread.

## 4. Contracts between the parts

- `src/lib/activity.ts`: `emitActivity` / `onActivity` / `hlcDevice`. Sync emits `source: "remote"`;
  the ink controller and the text/section editors emit `source: "local"`.
- `src/lib/chat-types.ts`: every chat type above. Server, `chat-api.ts` and the UI all import from
  here; change it only together with all three.
- `SidePanel` gets two new props from `NotebookEditor`: `mode: PanelMode` and `width: number`
  (px). `NotebookEditor` owns the layout state and the panel width; `SidePanel` owns what's in
  it (the Chat and Section tabs).

### Replay retention and edit endpoint

`from` offsets and `Turn.outputOffset` count Unicode code points (PostgreSQL
`length`), not UTF-16 units. Clients use `pollCursor(turns)` and `mergeTurns`.

Replay bundles (`chat_files`) and archived upload parts are retained only for the
latest turn of each live thread. Earlier turns retain their question, context
options/section IDs, attachment metadata, and results. Active jobs retain their
operational inputs until completion; finishing an older job does not archive its
parts again. Thread deletion drops all replay data and operational upload parts.
Migration removes pre-existing older/deleted replay copies.

`POST /api/chat/threads/[id]/turns/[turn]/edit` accepts `{ question }`, forks done
history through turn − 1, and queues the edited question with that turn's original
options, context, bundle and upload parts. Returns `{ thread }` (201). If the
original bytes are unavailable or incomplete it returns 409 with a message asking
the user to re-attach files and rebuild context. This bounds replay storage by
thread count without retaining megabytes for every message or silently sending
an edit with missing inputs. Edits of older text-only turns remain possible.

`uploadSpecs(files)` validates image/PDF attachments and creates the upload
manifest. `uploadTurnInputs(jobId, files, { onProgress, signal })` sends parts via
PUT to the existing job inputs endpoint with two retries for network/5xx/408
errors, handles a lost final acknowledgement, and cancels incomplete uploads.
