"use client";
import { useState } from "react";
import * as api from "@/lib/chat-api";
import type { PanelMode } from "@/lib/chat-types";
import { exportMarkdown, writeDraft } from "@/lib/chat-ui";
import { useChat } from "./useChat";
import { ModelPicker } from "./ModelPicker";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { ThreadList } from "./ThreadList";
import { ThreadSwitcher } from "./ThreadSwitcher";
import type { ContextProps } from "./ContextPicker";
export function ChatPanel(
  p: ContextProps & { notebookId: string; mode: PanelMode; visible: boolean },
) {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    list,
    thread,
    turns,
    id,
    draft,
    setDraft,
    busy,
    error,
    bridge,
    now,
    pending,
    undoTimer,
    setPending,
    collapsed,
    setCollapsed,
    patch,
    rowAction,
    run,
    select,
    setThread,
    action,
    send,
    refresh,
  } = useChat(p);
  return (
    <div data-chat-root className="flex min-h-0 w-full">
      <div
        className={
          p.mode === "chat" && !collapsed
            ? "w-60 shrink-0 overflow-y-auto border-r"
            : "hidden"
        }
      >
        <ThreadList {...list} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {p.mode === "drawing" && <ThreadSwitcher {...list} />}
        {p.mode === "chat" && (
          <button
            className="self-start p-2 text-xs"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "Show threads" : "Hide threads"}
          </button>
        )}
        {thread && (
          <header className="space-y-1 border-b p-2">
            <input
              aria-label="Thread title"
              className="w-full bg-transparent font-medium"
              key={thread.id + thread.title}
              defaultValue={thread.title}
              onBlur={(e) => {
                if (e.target.value !== thread.title)
                  patch({ title: e.target.value });
              }}
            />
            <div className="flex flex-wrap gap-1 text-xs">
              <select
                aria-label="Agent"
                value={thread.agent}
                onChange={(e) =>
                  patch({ agent: e.target.value as "claude" | "codex" })
                }
              >
                <option>claude</option>
                <option>codex</option>
              </select>
              <ModelPicker
                key={thread.id + thread.agent}
                thread={thread}
                patch={patch}
              />
              <label>
                <input
                  type="checkbox"
                  checked={!!thread.options.webSearch}
                  onChange={(e) =>
                    patch({
                      options: {
                        ...thread.options,
                        webSearch: e.target.checked,
                      },
                    })
                  }
                />{" "}
                Web search
              </label>
              <div
                className="relative"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setMenuOpen(false);
                    e.currentTarget.querySelector("button")?.focus();
                  }
                }}
              >
                <button
                  aria-label="Thread actions"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(!menuOpen)}
                >
                  •••
                </button>
                {menuOpen && (
                  <div className="flex flex-wrap gap-2 rounded-lg border bg-white p-2">
                    {["export", "archive", "delete"].map((kind) => (
                      <button
                        className="mr-2"
                        key={kind}
                        onClick={() => rowAction(kind, thread)}
                      >
                        {kind[0].toUpperCase() + kind.slice(1)}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        run(async () => {
                          const data = await api.forkThread(
                            id,
                            turns.at(-1)?.turn ?? 0,
                          );
                          select(data.thread.id);
                          setThread(data.thread);
                        })
                      }
                    >
                      Fork
                    </button>
                    <button
                      onClick={() =>
                        run(() =>
                          navigator.clipboard.writeText(
                            exportMarkdown(thread, turns),
                          ),
                        )
                      }
                    >
                      Copy thread
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>
        )}
        {error && (
          <p role="alert" className="p-2 text-xs text-rose-700">
            {error}
          </p>
        )}
        {turns.some((t) => t.status === "queued") &&
          (!bridge || now - Date.parse(bridge) > 30000) && (
            <p className="p-2 text-xs text-slate-500">
              Waiting for the bridge on your Mac
            </p>
          )}
        <Conversation
          key={id}
          turns={turns}
          notebookId={p.notebookId}
          sections={p.sections}
          action={action}
          edit={async (turn, question) => {
            const data = await api.editTurn(id, turn.turn, question);
            select(data.thread.id);
            setThread(data.thread);
            refresh();
          }}
          fork={async (turn, question) => {
            const data = await api.forkThread(id, turn.turn - 1);
            select(data.thread.id);
            setThread(data.thread);
            setDraft(question);
            writeDraft(data.thread.id, question);
            refresh();
          }}
        />
        <Composer
          {...p}
          draft={draft}
          setDraft={(s) => {
            setDraft(s);
            writeDraft(id, s);
          }}
          busy={busy}
          send={send}
          stop={() => {
            const active = turns.find((t) =>
              ["queued", "running"].includes(t.status),
            );
            if (active) action("stop", active);
          }}
        />
        {pending && (
          <div role="status" className="p-2">
            Thread deleted.{" "}
            <button
              className="text-blue-700"
              onClick={() => {
                if (undoTimer.current) clearTimeout(undoTimer.current);
                setPending(null);
              }}
            >
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
