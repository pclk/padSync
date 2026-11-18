"use client";
import { useEffect, useRef, useState } from "react";
import * as api from "@/lib/chat-api";
import { downloadFile } from "@/lib/download";
import type {
  CatalogAccount,
  ChatAgent,
  ChatOptions,
  ThreadPatch,
  ThreadSummary,
  Turn,
} from "@/lib/chat-types";
import {
  createPollScheduler,
  describeModel,
  exportMarkdown,
  fallbackCatalog,
  groupThreads,
  pollDelay,
  readDraft,
  readStored,
  reusableThread,
  toolsOf,
  writeDraft,
  writeStored,
  type ThreadFilter,
} from "@/lib/chat-ui";
import type { ThreadListProps } from "./ThreadList";
import type { ContextHandle } from "./ContextPicker";

export function useChat(p: { notebookId: string; visible: boolean }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [id, setId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThreadFilter>("notebook");
  const [collapsed, setCollapsedState] = useState(() =>
    readStored("padsync.chat.sidebarCollapsed", false),
  );
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    writeStored("padsync.chat.sidebarCollapsed", v);
  };
  // Model and tools for the next new chat: whatever was picked last.
  const [defaults, setDefaults] = useState<{ agent: ChatAgent; options: ChatOptions }>(() =>
    readStored("padsync.chat.defaults", { agent: "claude", options: {} }),
  );
  const [catalog, setCatalog] = useState<CatalogAccount[] | null>(null);
  const catalogAt = useRef(0);
  const [loadedId, setLoadedId] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(() => readDraft(""));
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<Record<string, string>>(() =>
    readStored("padsync.chat.seen", {}),
  );
  const [pending, setPending] = useState<ThreadSummary | null>(null);
  const [bridge, setBridge] = useState<string | null>(null);
  const [tabVisible, setTabVisible] = useState(true);
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  const requests = useRef(new Set<string>());
  const since = useRef<string | undefined>(undefined);
  const listPoll = useRef<ReturnType<typeof createPollScheduler> | null>(null);
  const detailPoll = useRef<ReturnType<typeof createPollScheduler> | null>(
    null,
  );
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = useRef(id);
  useEffect(() => {
    selected.current = id;
  }, [id]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const select = (next: string) => {
    writeDraft(id, draft);
    setDraft(readDraft(next));
    selected.current = next;
    turnsRef.current = [];
    setId(next);
    setTurns([]);
    setThread(threads.find((t) => t.id === next) ?? null);
    since.current = undefined;
  };
  const refresh = () => {
    listPoll.current?.refresh();
    detailPoll.current?.refresh();
  };
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const change = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    change();
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (!p.visible || !tabVisible || Date.now() - catalogAt.current < 5 * 60_000) return;
    catalogAt.current = Date.now();
    api
      .getCatalog()
      .then((data) => setCatalog(data.accounts))
      .catch(() => {
        catalogAt.current = 0;
      });
  }, [p.visible, tabVisible]);
  useEffect(() => {
    const scheduler = createPollScheduler(
      async () => {
        try {
          const data = await api.listThreads({
            notebookId: filter === "notebook" ? p.notebookId : undefined,
            q: query,
            archived: filter === "archived",
          });
          setThreads(data.threads);
          setBridge(data.bridgeSeenAt);
          setNow(Date.now());
        } catch (e) {
          setError((e as Error).message);
        }
      },
      () => pollDelay("list", false),
      () => p.visible && tabVisible,
    );
    listPoll.current = scheduler;
    scheduler.refresh();
    return () => scheduler.stop();
  }, [p.notebookId, p.visible, tabVisible, query, filter]);
  useEffect(() => {
    if (!id) return;
    let live = true;
    const scheduler = createPollScheduler(
      async () => {
        if (requests.current.has(id)) return;
        requests.current.add(id);
        try {
          const data = await api.getThread(id, {
            since: since.current,
            from: api.pollCursor(turnsRef.current),
          });
          if (!live || selected.current !== id) return;
          setThread(data.thread);
          setTurns((old) => api.mergeTurns(old, data.turns));
          setLoadedId(id);
          since.current = data.now;
          setBridge(data.bridgeSeenAt);
          setNow(Date.now());
          setSeen((old) => {
            const next = { ...old, [id]: data.thread.updatedAt };
            writeStored("padsync.chat.seen", next);
            return next;
          });
          setError("");
        } catch (e) {
          if (live) setError((e as Error).message);
        } finally {
          requests.current.delete(id);
        }
      },
      () =>
        pollDelay(
          "thread",
          turnsRef.current.some((t) =>
            ["queued", "running", "uploading"].includes(t.status),
          ),
        ),
      () => p.visible && tabVisible,
    );
    detailPoll.current = scheduler;
    scheduler.refresh();
    return () => {
      live = false;
      scheduler.stop();
    };
  }, [id, p.visible, tabVisible]);
  const run = (fn: () => Promise<unknown>) => {
    void fn()
      .then(refresh)
      .catch((e) => setError((e as Error).message));
  };
  const focusComposer = () =>
    setTimeout(
      () =>
        document
          .querySelector<HTMLTextAreaElement>("[data-chat-composer]")
          ?.focus(),
      0,
    );
  /** "New chat" goes to an untouched chat if there is one, else makes one. */
  const create = async () => {
    const empty = reusableThread(threads, p.notebookId, {
      id,
      turns: turns.length,
    });
    if (empty) {
      if (empty.id !== id) {
        select(empty.id);
        setThread(empty);
      }
      focusComposer();
      return empty;
    }
    const options = { ...defaults.options, ...toolsOf(defaults.options) };
    const data = await api.createThread({
      notebookId: p.notebookId,
      agent: defaults.agent,
      options,
    });
    setThreads((old) => [data.thread, ...old]);
    select(data.thread.id);
    setThread(data.thread);
    refresh();
    focusComposer();
    return data.thread;
  };
  const patch = (input: ThreadPatch) => {
    if (thread)
      run(async () => {
        const data = await api.updateThread(thread.id, input);
        setThread(data.thread);
      });
  };
  const settings = thread
    ? { agent: thread.agent, options: thread.options }
    : defaults;
  /** Model, effort and tools apply to the open chat's next turns and to new chats. */
  const setSettings = (next: { agent: ChatAgent; options: ChatOptions }) => {
    setDefaults(next);
    writeStored("padsync.chat.defaults", next);
    if (!thread) return;
    setThread({ ...thread, ...next });
    patch(next);
  };
  const accounts = catalog?.length ? catalog : fallbackCatalog();
  const modelLabel = (s: { agent: ChatAgent; options: ChatOptions }) =>
    describeModel(accounts, s).label;
  const download = (t: ThreadSummary, messages: Turn[]) =>
    downloadFile("conversation.md", exportMarkdown(t, messages), "text/markdown");
  const rowAction = (kind: string, t: ThreadSummary, title?: string) =>
    run(async () => {
      if (kind === "export")
        return download(t, (await api.getThread(t.id)).turns);
      if (kind === "delete") {
        if (undoTimer.current) {
          clearTimeout(undoTimer.current);
          if (pending) await api.deleteThread(pending.id);
        }
        setPending(t);
        undoTimer.current = setTimeout(() => {
          run(async () => {
            await api.deleteThread(t.id);
            setPending(null);
            if (selected.current === t.id) select("");
          });
        }, 5000);
        return;
      }
      await api.updateThread(
        t.id,
        kind === "rename"
          ? { title }
          : kind.includes("pin")
            ? { pinned: kind === "pin" }
            : { archived: kind === "archive" },
      );
    });
  const send = async (
    text: string,
    context: ContextHandle | null,
    files: File[],
    onProgress: Parameters<typeof api.uploadTurnInputs>[2],
  ) => {
    setBusy(true);
    try {
      const inputs = await Promise.all(
        files.map(async (file, index) => ({
          path: `attachment-${index + 1}.${
            file.name
              .split(".")
              .pop()
              ?.replace(/[^a-zA-Z0-9]/g, "") || "bin"
          }`,
          mime: file.type,
          base64: await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () =>
              reject(new Error(`Could not read ${file.name}`));
            reader.readAsDataURL(file);
          }),
        })),
      );
      const bundle = await context?.prepare();
      const target = thread ?? (await create());
      const tools = toolsOf(target.options);
      const sent = await api.sendTurn(target.id, {
        question: text,
        files: bundle?.files ?? [],
        uploads: api.uploadSpecs(inputs),
        context: bundle?.context,
        // Running code needs the writable job folder, so it brings edits with it.
        options: {
          ...target.options,
          ...tools,
          allowEdits: (bundle?.options.allowEdits ?? true) || tools.allowCode,
        },
      });
      await api.uploadTurnInputs(sent.turn.jobId, inputs, onProgress);
      if (selected.current === target.id) setDraft("");
      writeDraft(target.id, "");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const action = (kind: string, t: Turn) =>
    run(async () => {
      if (kind === "copy") return navigator.clipboard.writeText(t.output);
      if (kind === "stop") return api.cancelTurn(t.jobId);
      if (kind === "regenerate") return api.regenerateTurn(id, t.turn);
      if (kind === "retry") {
        if (t.turn === turns.at(-1)?.turn)
          return api.regenerateTurn(id, t.turn);
        const data = await api.editTurn(id, t.turn, t.question);
        select(data.thread.id);
        setThread(data.thread);
      }
    });
  const list: ThreadListProps = {
    now,
    threads: groupThreads(threads, filter, p.notebookId).filter(
      (t) => t.id !== pending?.id,
    ),
    selected: id,
    seen,
    search,
    setSearch,
    filter,
    setFilter,
    select,
    create: () => run(create),
    action: rowAction,
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const input = (e.target as HTMLElement).matches(
        "input,textarea,select,[contenteditable=true]",
      );
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (collapsed) setCollapsed(false);
        document
          .querySelector("[data-chat-switcher]")
          ?.dispatchEvent(new Event("chat-open-switcher"));
        setTimeout(
          () =>
            [
              ...document.querySelectorAll<HTMLInputElement>(
                "[data-chat-search]",
              ),
            ]
              .find((el) => el.offsetParent !== null)
              ?.focus(),
          0,
        );
      }
      if (e.altKey && e.code === "KeyN") {
        e.preventDefault();
        run(create);
      }
      if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        const i = list.threads.findIndex((t) => t.id === id);
        const next = list.threads[i + (e.key === "ArrowUp" ? -1 : 1)];
        if (next) select(next.id);
      }
      if (e.key === "/" && !input) {
        e.preventDefault();
        document
          .querySelector<HTMLTextAreaElement>("[data-chat-composer]")
          ?.focus();
      }
    };
    if (p.visible) window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return {
    list,
    thread,
    turns,
    id,
    settings,
    setSettings,
    accounts,
    fallbackModels: !catalog?.length,
    modelLabel,
    loading: !!id && loadedId !== id,
    focusComposer,
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
  };
}
