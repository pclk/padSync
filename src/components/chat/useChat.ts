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
  CHAT_IDLE_AFTER_MS,
  createPollScheduler,
  describeModel,
  exportMarkdown,
  fallbackCatalog,
  groupThreads,
  newChatSettings,
  pollDelay,
  readDraft,
  readStored,
  reusableThread,
  toolsOf,
  writeDraft,
  writeStored,
  type ModelChoice,
  type ThreadFilter,
} from "@/lib/chat-ui";
import { priceFor, type Price } from "@/lib/chat-cost";
import { MAX_BUNDLE_BYTES } from "@/lib/context";
import { clientClock, localMarks, markLocal, noteServerTime } from "@/lib/chat-trace";
import { watchLive } from "@/lib/live-query";
import { voiceFile } from "./useVoice";
import { useLiveQuery } from "dexie-react-hooks";
import { deviceKind } from "@/lib/db";
import { latestChatPing, publishChatFocus } from "@/lib/chat-handoff";
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
  // The model new chats start on, synced to every device (src/server/prefs.ts); the local copy
  // shows it instantly while the server's is fetched.
  const [defaultModel, setDefaultModelState] = useState<ModelChoice | null>(() =>
    readStored("padsync.chat.defaultModel", null),
  );
  /** A model picked before the first message of a new chat: used for that chat only. */
  const [pendingSettings, setPendingSettings] = useState<{ agent: ChatAgent; options: ChatOptions } | null>(null);
  /** When the synced preferences last loaded; 0 until they have. */
  const prefsAt = useRef(0);
  const [catalog, setCatalog] = useState<CatalogAccount[] | null>(null);
  const catalogAt = useRef(0);
  const [prices, setPrices] = useState<Record<string, Price> | null>(null);
  const [loadedId, setLoadedId] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(() => readDraft(""));
  // The draft as typed now, which a send that took a while compares with what it sent.
  const draftNow = useRef(draft);
  useEffect(() => {
    draftNow.current = draft;
  }, [draft]);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<Record<string, string>>(() =>
    readStored("padsync.chat.seen", {}),
  );
  const [pending, setPending] = useState<ThreadSummary | null>(null);
  const [bridge, setBridge] = useState<string | null>(null);
  const [tabVisible, setTabVisible] = useState(true);
  /** The open chat's live query is connected: changes arrive as they happen, so polling slows. */
  const realtimeLive = useRef(false);
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
  // When this chat last changed or was used; quiet for CHAT_IDLE_AFTER_MS, its polls slow down.
  const activeAt = useRef(0);
  useEffect(() => {
    activeAt.current = Date.now();
  }, []);
  const idle = () => Date.now() - activeAt.current > CHAT_IDLE_AFTER_MS;
  const select = (next: string) => {
    activeAt.current = Date.now();
    writeDraft(id, draft);
    setDraft(readDraft(next));
    selected.current = next;
    turnsRef.current = [];
    setPendingSettings(null);
    setId(next);
    setTurns([]);
    setThread(threads.find((t) => t.id === next) ?? null);
    since.current = undefined;
  };
  const refresh = () => {
    activeAt.current = Date.now();
    listPoll.current?.refresh();
    detailPoll.current?.refresh();
  };
  /** Keeps this device's stamps with the turn too, so its latency report is complete anywhere. */
  const reportMarks = (jobId: string, trace: Record<string, number>) => void api.addTrace(jobId, trace).catch(() => {});
  // The iPad app sends its prompts to the chat a computer shows (src/lib/chat-handoff.ts): say
  // which one this is, and jump to a chat the iPad just asked in, so its reply shows here live.
  const desktop = deviceKind() === "desktop";
  useEffect(() => {
    if (!desktop || !p.visible || !tabVisible || !id || !p.notebookId) return;
    void publishChatFocus(p.notebookId, id);
    // The iPad trusts a focus for 12 h (ios/PadSync/Controls/Prompts.swift); each write wakes the database.
    const timer = setInterval(() => void publishChatFocus(p.notebookId, id), 2 * 3_600_000);
    return () => clearInterval(timer);
  }, [desktop, p.visible, tabVisible, id, p.notebookId]);
  const ping = useLiveQuery(() => (desktop && p.notebookId ? latestChatPing(p.notebookId) : undefined), [desktop, p.notebookId]);
  // Pings from before this panel opened are history, not a new ask.
  const seenPing = useRef<number | null>(null);
  useEffect(() => {
    seenPing.current ??= Date.now() - 60_000;
    if (!ping || ping.data.at <= seenPing.current) return;
    seenPing.current = ping.data.at;
    if (ping.data.chatThreadId !== selected.current) select(ping.data.chatThreadId);
    else refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ping]);
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
    if (!p.visible || !tabVisible) return;
    const load = () =>
      api
        .getPrefs()
        .then(({ prefs }) => {
          const next = (prefs["chat.defaultModel"] as ModelChoice | undefined) ?? null;
          prefsAt.current = Date.now();
          setDefaultModelState(next);
          writeStored("padsync.chat.defaultModel", next);
        })
        .catch(() => {});
    load();
    // Picks up a default changed on another device without a reload (showing the tab again does too).
    const timer = setInterval(load, 10 * 60_000);
    return () => clearInterval(timer);
  }, [p.visible, tabVisible]);
  useEffect(() => {
    if (!p.visible || prices) return;
    api
      .getPricing()
      .then((data) => setPrices(data.prices))
      .catch(() => {});
  }, [p.visible, prices]);
  useEffect(() => {
    const scheduler = createPollScheduler(
      async () => {
        try {
          const data = await api.listThreads({
            notebookId: filter === "notebook" ? p.notebookId : undefined,
            q: query,
            archived: filter === "archived",
          });
          setThreads((old) => {
            if (JSON.stringify(old) !== JSON.stringify(data.threads)) activeAt.current = Date.now();
            return data.threads;
          });
          setBridge(data.bridgeSeenAt);
          setNow(Date.now());
        } catch (e) {
          setError((e as Error).message);
        }
      },
      () => pollDelay("list", false, false, idle()),
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
          const sentAt = Date.now();
          const data = await api.getThread(id, {
            since: since.current,
            from: api.pollCursor(turnsRef.current),
          });
          const seenAt = Date.now();
          if (data.serverTime) noteServerTime(data.serverTime, sentAt, seenAt);
          // Latency trace: when this device first showed words, and the finished reply, of turns it sent.
          for (const t of data.turns) {
            if (localMarks(t.jobId)["client.response"] === undefined) continue;
            if (t.output && markLocal(t.jobId, "client.first_output_seen", seenAt)) reportMarks(t.jobId, { "client.first_output_seen": seenAt });
            if (["done", "error", "cancelled"].includes(t.status) && markLocal(t.jobId, "client.done_seen", seenAt)) reportMarks(t.jobId, { "client.done_seen": seenAt });
          }
          if (!live || selected.current !== id) return;
          if (data.turns.length) activeAt.current = Date.now();
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
          realtimeLive.current,
          idle(),
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
  useEffect(() => {
    if (!id || !p.visible || !tabVisible) return;
    const stop = watchLive({
      capability: () => api.liveThread(id),
      onChange: () => detailPoll.current?.refresh(),
      onStatus: (s) => {
        realtimeLive.current = s === "live";
      },
    });
    return () => {
      stop();
      realtimeLive.current = false;
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
    // A toolbar prompt can open the panel and send before its preference poll finishes; once it
    // has (the poll repeats every minute), the default is known without another round trip.
    const savedModel = pendingSettings
      ? null
      : prefsAt.current
        ? defaultModel
        : await api
            .getPrefs()
            .then(({ prefs }) => (prefs["chat.defaultModel"] as ModelChoice | undefined) ?? null)
            .catch(() => defaultModel);
    const start = pendingSettings ?? newChatSettings(defaults, savedModel);
    const options = { ...start.options, ...toolsOf(start.options) };
    setPendingSettings(null);
    let empty = reusableThread(threads, p.notebookId, {
      id,
      turns: turns.length,
    });
    if (empty) {
      // An untouched chat made earlier still starts on today's default, and its tools; one that
      // already does needs no update.
      const current = empty.options as Record<string, unknown>;
      const wanted = options as Record<string, unknown>;
      const same = empty.agent === start.agent && Object.keys({ ...current, ...wanted }).every((k) => JSON.stringify(current[k]) === JSON.stringify(wanted[k]));
      if (!same) empty = (await api.updateThread(empty.id, { agent: start.agent, options })).thread;
      if (empty.id !== id) select(empty.id);
      setThread(empty);
      focusComposer();
      return empty;
    }
    const data = await api.createThread({
      notebookId: p.notebookId,
      agent: start.agent,
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
        // Switched to another chat meanwhile: this one's reply mustn't become the open chat,
        // or the next message would go to it.
        if (selected.current === data.thread.id) setThread(data.thread);
      });
  };
  const settings = thread
    ? { agent: thread.agent, options: thread.options }
    : (pendingSettings ?? newChatSettings(defaults, defaultModel));
  /**
   * Model, effort and tools apply to the open chat's next turns. They are also remembered on this
   * device for new chats, though a synced default model takes precedence over the model part.
   */
  const setSettings = (next: { agent: ChatAgent; options: ChatOptions }) => {
    setDefaults(next);
    writeStored("padsync.chat.defaults", next);
    if (!thread) return setPendingSettings(next);
    setThread({ ...thread, ...next });
    patch(next);
  };
  /** Saves (or with null, clears) the default model on the server, for every device. */
  const setDefaultModel = (next: ModelChoice | null) => {
    const before = defaultModel;
    setDefaultModelState(next);
    writeStored("padsync.chat.defaultModel", next);
    api.putPref("chat.defaultModel", next).catch((e: Error) => {
      setDefaultModelState(before);
      writeStored("padsync.chat.defaultModel", before);
      setError(`Could not save the default model: ${e.message}`);
    });
  };
  const accounts = catalog?.length ? catalog : fallbackCatalog();
  const modelLabel = (s: { agent: ChatAgent; options: ChatOptions }) =>
    describeModel(accounts, s).label;
  /** API list price of the model a turn ran on; null until loaded or when unknown. */
  const priceOf = (s: { agent: ChatAgent; options: ChatOptions }) =>
    prices ? priceFor(prices, s, describeModel(accounts, s).account?.defaultModel) : null;
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
    context: Pick<ContextHandle, "prepare"> | null,
    files: File[],
    onProgress: Parameters<typeof api.uploadTurnInputs>[2],
    /** A recorded voice message: the Mac transcribes it into (the rest of) the question. */
    voice?: Blob,
    /** When the user pressed send (or let go of the mic), and other "client.*" stamps. */
    marks: Record<string, number> = { "client.pressed": Date.now() },
  ) => {
    setBusy(true);
    try {
      const readBase64 = (blob: Blob, name: string) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error(`Could not read ${name}`));
          reader.readAsDataURL(blob);
        });
      const inputs = await Promise.all(
        files.map(async (file, index) => ({
          path: `attachment-${index + 1}.${
            file.name
              .split(".")
              .pop()
              ?.replace(/[^a-zA-Z0-9]/g, "") || "bin"
          }`,
          mime: file.type,
          base64: await readBase64(file, file.name),
        })),
      );
      const audio = voice && { ...voiceFile(voice.type), base64: await readBase64(voice, "the recording") };
      const bundle = await context?.prepare();
      // A voice message rides in the turn itself when it fits (one request fewer before the Mac
      // can start); a long one goes up in parts like any other attachment.
      const bundleSize = (bundle?.files ?? []).reduce((n, f) => n + (f.text ?? f.base64 ?? "").length, 0);
      const inline = !!audio && audio.base64.length <= 1_500_000 && bundleSize + audio.base64.length <= MAX_BUNDLE_BYTES;
      if (audio && !inline) inputs.push(audio);
      const target = thread ?? (await create());
      const tools = toolsOf(target.options);
      const clock = clientClock();
      const sentAt = Date.now();
      const trace = { ...marks, "client.sent": sentAt, ...(clock ? { "client.clock_offset": clock.offset, "client.clock_rtt": clock.rtt } : {}) };
      const sent = await api.sendTurn(target.id, {
        trace,
        question: text,
        files: [...(bundle?.files ?? []), ...(audio && inline ? [audio] : [])],
        uploads: api.uploadSpecs(inputs),
        context: bundle?.context,
        // Running code needs the writable job folder, so it brings edits with it.
        options: {
          ...target.options,
          ...tools,
          allowEdits: (bundle?.options.allowEdits ?? true) || tools.allowCode,
        },
      });
      const responseAt = Date.now();
      if (sent.serverTime) noteServerTime(sent.serverTime, sentAt, responseAt);
      markLocal(sent.turn.jobId, "client.response", responseAt);
      // A new chat's first message goes before any poll has measured the clock; its own round trip just did.
      const measured = clientClock();
      reportMarks(sent.turn.jobId, {
        "client.response": responseAt,
        ...(!clock && measured ? { "client.clock_offset": measured.offset, "client.clock_rtt": measured.rtt } : {}),
      });
      // Known at once, so polling treats the reply as running even if a fetch already in flight
      // (one that started before the turn existed) comes back without it.
      if (selected.current === target.id) {
        turnsRef.current = api.mergeTurns(turnsRef.current, [sent.turn]);
        setTurns((old) => api.mergeTurns(old, [sent.turn]));
      }
      await api.uploadTurnInputs(sent.turn.jobId, inputs, onProgress);
      // Clears the box only if it still holds what was sent: not a draft typed during a slow
      // upload, nor one a toolbar prompt (which sends its own text) found there.
      const sentText = text.trim();
      if (selected.current === target.id && draftNow.current.trim() === sentText) setDraft("");
      if (readDraft(target.id).trim() === sentText) writeDraft(target.id, "");
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
    defaultModel,
    setDefaultModel,
    accounts,
    fallbackModels: !catalog?.length,
    modelLabel,
    priceOf,
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
    /** Whether the open chat's live query is connected right now. */
    realtime: () => realtimeLive.current,
  };
}
