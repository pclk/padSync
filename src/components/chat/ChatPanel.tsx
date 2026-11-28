"use client";
import * as api from "@/lib/chat-api";
import type { PanelMode } from "@/lib/chat-types";
import { exportMarkdown, pollDelay, writeDraft } from "@/lib/chat-ui";
import { latencyReport } from "@/lib/chat-trace";
import { useIsMac } from "./LatencyTrace";
import { useChat } from "./useChat";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { Icon, type IconName } from "../Icons";
import { ThreadList } from "./ThreadList";
import { ThreadSwitcher } from "./ThreadSwitcher";
import { MenuItem, usePopover } from "./Popover";
import type { ContextProps } from "./ContextPicker";
export function ChatPanel(
  p: ContextProps & { mode: PanelMode; visible: boolean },
) {
  const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
  const c = useChat(p);
  const { thread, turns, id } = c;
  const isMac = useIsMac();
  const wide = p.mode === "chat";
  const running = turns.some((t) =>
    ["queued", "running", "uploading"].includes(t.status),
  );
  // A connected bridge claims a new turn within a second or two; it no longer checks in on a timer
  // (that kept Neon from scaling to zero), so a turn left queued is what says it's away. A turn
  // behind one still running is only waiting its turn.
  const bridgeAway =
    !turns.some((t) => t.status === "running" || t.status === "uploading") &&
    turns.some((t) => t.status === "queued" && c.now - Date.parse(t.createdAt) > 15000);
  const threadActions: [string, IconName, string, () => void][] = thread
    ? [
        [
          "fork",
          "fork",
          "Fork from here",
          () =>
            c.run(async () => {
              const data = await api.forkThread(id, turns.at(-1)?.turn ?? 0);
              c.select(data.thread.id);
              c.setThread(data.thread);
            }),
        ],
        [
          "copy",
          "copy",
          "Copy as Markdown",
          () =>
            c.run(() =>
              navigator.clipboard.writeText(exportMarkdown(thread, turns)),
            ),
        ],
        ["export", "download", "Export Markdown", () => c.rowAction("export", thread)],
        ...(isMac
          ? ([
              [
                "latency",
                "activity",
                "Copy latency report",
                () =>
                  c.run(() =>
                    navigator.clipboard.writeText(
                      latencyReport(thread, turns, {
                        device: navigator.userAgent,
                        pollMs: { active: pollDelay("thread", true, c.realtime()), idle: pollDelay("thread", false, c.realtime()) },
                        bridgePollMs: 3000, // bridge/padsync-bridge.ts POLL_MS (30 min once its own live query connects)
                        realtime: c.realtime(),
                      }),
                    ),
                  ),
              ],
            ] as [string, IconName, string, () => void][])
          : []),
        [
          thread.pinned ? "unpin" : "pin",
          "pin",
          thread.pinned ? "Unpin" : "Pin",
          () => c.rowAction(thread.pinned ? "unpin" : "pin", thread),
        ],
        ["archive", "archive", thread.archived ? "Unarchive" : "Archive", () => c.rowAction(thread.archived ? "unarchive" : "archive", thread)],
        ["delete", "trash", "Delete", () => c.rowAction("delete", thread)],
      ]
    : [];
  return (
    <div data-chat-root className="flex min-h-0 w-full bg-white">
      {wide && !c.collapsed && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
          <ThreadList {...c.list} />
        </aside>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 px-2 pointer-coarse:h-14">
          {wide && (
            <button
              className="icon-btn h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10"
              aria-label={c.collapsed ? "Show chats" : "Hide chats"}
              title={c.collapsed ? "Show chats" : "Hide chats"}
              onClick={() => c.setCollapsed(!c.collapsed)}
            >
              <Icon name="sidebar" />
            </button>
          )}
          {wide ? (
            thread ? (
              <input
                aria-label="Chat title"
                className="h-8 min-w-0 flex-1 truncate rounded-lg bg-transparent px-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus:bg-slate-100"
                key={thread.id + thread.title}
                defaultValue={thread.title}
                placeholder="New chat"
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  if (e.target.value !== thread.title)
                    c.patch({ title: e.target.value });
                }}
              />
            ) : (
              <span className="flex-1 px-2 text-sm font-semibold text-slate-800">New chat</span>
            )
          ) : (
            <ThreadSwitcher {...c.list} title={thread?.title ?? ""} />
          )}
          {(!wide || c.collapsed) && (
            <button
              className="icon-btn h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10"
              aria-label="New chat"
              title="New chat (⌥N)"
              onClick={c.list.create}
            >
              <Icon name="compose" />
            </button>
          )}
          {thread && (
            <div ref={menuRef} className="relative">
              <button
                data-popover-trigger
                className="icon-btn h-8 w-8 pointer-coarse:h-10 pointer-coarse:w-10"
                aria-label="Chat actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Icon name="more" />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-48 pointer-coarse:w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lift">
                  {threadActions.map(([key, icon, label, fn]) => (
                    <MenuItem
                      key={key}
                      danger={key === "delete"}
                      onClick={() => {
                        setMenuOpen(false);
                        fn();
                      }}
                    >
                      <Icon name={icon} /> {label}
                    </MenuItem>
                  ))}
                </div>
              )}
            </div>
          )}
        </header>
        {c.error && (
          <p role="alert" className="mx-3 mb-1 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <Icon name="alert" className="shrink-0" /> {c.error}
          </p>
        )}
        <Conversation
          key={id}
          turns={turns}
          notebookId={p.notebookId}
          sections={p.sections}
          action={c.action}
          modelLabel={c.modelLabel}
          priceOf={c.priceOf}
          loading={c.loading}
          suggest={(text) => {
            c.setDraft(text);
            writeDraft(id, text);
            c.focusComposer();
          }}
          edit={async (turn, question) => {
            const data = await api.editTurn(id, turn.turn, question);
            c.select(data.thread.id);
            c.setThread(data.thread);
            c.refresh();
          }}
          fork={async (turn, question) => {
            const data = await api.forkThread(id, turn.turn - 1);
            c.select(data.thread.id);
            c.setThread(data.thread);
            c.setDraft(question);
            writeDraft(data.thread.id, question);
            c.refresh();
          }}
        />
        {bridgeAway && (
          <p className="mx-auto mb-1 flex max-w-[48rem] items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800">
            <Icon name="clock" /> Waiting for the bridge on your Mac
          </p>
        )}
        {c.pending && (
          <div role="status" className="mx-auto mb-1 flex items-center gap-3 rounded-full bg-slate-900 px-4 py-1.5 text-xs text-white shadow-lift">
            Chat deleted
            <button
              className="font-semibold underline-offset-2 hover:underline"
              onClick={() => {
                if (c.undoTimer.current) clearTimeout(c.undoTimer.current);
                c.setPending(null);
              }}
            >
              Undo
            </button>
          </div>
        )}
        <Composer
          {...p}
          draft={c.draft}
          setDraft={(s) => {
            c.setDraft(s);
            writeDraft(id, s);
          }}
          busy={c.busy}
          visible={p.visible}
          running={running}
          settings={c.settings}
          setSettings={c.setSettings}
          defaultModel={c.defaultModel}
          setDefaultModel={c.setDefaultModel}
          accounts={c.accounts}
          fallbackModels={c.fallbackModels}
          send={c.send}
          stop={() => {
            const active = turns.find((t) =>
              ["queued", "running"].includes(t.status),
            );
            if (active) c.action("stop", active);
          }}
        />
      </div>
    </div>
  );
}
