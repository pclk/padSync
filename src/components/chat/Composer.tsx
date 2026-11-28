"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { composerAction, toolsOf, validateAttachments, type ModelChoice } from "@/lib/chat-ui";
import type { uploadTurnInputs } from "@/lib/chat-api";
import type { CatalogAccount, ChatAgent, ChatOptions } from "@/lib/chat-types";
import {
  ContextPicker,
  type ContextHandle,
  type ContextProps,
} from "./ContextPicker";
import { ModelPicker } from "./ModelPicker";
import { MenuItem, usePopover } from "./Popover";
import { isTalkKey, useVoice } from "./useVoice";
import { Icon, type IconName } from "../Icons";
import { PROMPT_EVENT, peekPrompt, takePrompt, type QueuedPrompt } from "@/lib/prompts";

type Settings = { agent: ChatAgent; options: ChatOptions };

export function Composer(
  p: ContextProps & {
    draft: string;
    setDraft(s: string): void;
    busy: boolean;
    /** The chat is on screen: the hold-to-talk hotkey only listens then. */
    visible: boolean;
    /** A reply is queued or streaming: the send button becomes Stop while the box is empty. */
    running: boolean;
    settings: Settings;
    setSettings(next: Settings): void;
    defaultModel: ModelChoice | null;
    setDefaultModel(next: ModelChoice | null): void;
    accounts: CatalogAccount[];
    fallbackModels: boolean;
    send(
      text: string,
      context: Pick<ContextHandle, "prepare"> | null,
      files: File[],
      progress: Parameters<typeof uploadTurnInputs>[2],
      voice?: Blob,
      marks?: Record<string, number>,
    ): Promise<void>;
    stop(): void;
  },
) {
  const ctx = useRef<ContextHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const tools = toolsOf(p.settings.options);
  function addFiles(incoming: File[]) {
    if (p.busy) return;
    const next = [...files, ...incoming];
    const problem = validateAttachments(next);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setFiles(next);
  }
  // Grow with the text up to the CSS max height, also when a draft is restored or cleared.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [p.draft]);
  useEffect(() => {
    const panel = picker.current?.closest("[data-chat-root]");
    let depth = 0;
    function enter(event: Event) {
      const e = event as DragEvent;
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    }
    function leave() {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    }
    function drag(event: Event) {
      const e = event as DragEvent;
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    function drop(event: Event) {
      const e = event as DragEvent;
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      addFiles(Array.from(e.dataTransfer.files));
    }
    panel?.addEventListener("dragenter", enter);
    panel?.addEventListener("dragleave", leave);
    panel?.addEventListener("dragover", drag);
    panel?.addEventListener("drop", drop);
    return () => {
      panel?.removeEventListener("dragenter", enter);
      panel?.removeEventListener("dragleave", leave);
      panel?.removeEventListener("dragover", drag);
      panel?.removeEventListener("drop", drop);
    };
  });
  async function send(voice?: Blob, marks: Record<string, number> = { "client.pressed": Date.now() }) {
    if ((!p.draft.trim() && !voice) || p.busy) return;
    setError("");
    setProgress(0);
    try {
      await p.send(p.draft.trim(), ctx.current, files, {
        onProgress: (sent: number, total: number) =>
          setProgress(total ? (sent / total) * 100 : 100),
      }, voice, marks);
      setFiles([]);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  // A prompt picked from the iPad's prompt menu (prompts.ts): sent with its own context (or this
  // chat's), and its voice message if it recorded one; one marked to finish goes into the box.
  // While a reply is still being sent it waits, and goes once the composer is free.
  const sendPrompt = ({ prompt, audio }: QueuedPrompt) => {
    const scope = prompt.context === "chat" ? undefined : prompt.context;
    const picker = ctx.current;
    const context = picker && { prepare: () => picker.prepare(scope) };
    return p.send(prompt.text.trim(), context, [], { onProgress: () => {} }, audio).catch((error) => {
      setError((error as Error).message);
      // A recording can't be made again: keep it to retry rather than lose it with the error.
      if (audio) setFailed({ prompt, audio, notebookId: p.notebookId });
    });
  };
  const [failed, setFailed] = useState<QueuedPrompt | null>(null);
  const latest = useRef({ sendPrompt, setDraft: p.setDraft, busy: p.busy });
  useEffect(() => {
    latest.current = { sendPrompt, setDraft: p.setDraft, busy: p.busy };
  });
  // Works through the queue: prompts to finish go into the box, and the first one to send goes
  // (the rest follow as each send finishes). A prompt to finish doesn't stop the ones after it.
  const notebookId = p.notebookId;
  const takeQueued = useCallback(() => {
    for (;;) {
      const q = peekPrompt(notebookId);
      if (!q) return;
      const l = latest.current;
      const sending = q.audio || q.prompt.send;
      if (sending && l.busy) return;
      takePrompt(notebookId);
      if (sending) return void l.sendPrompt(q);
      if (q.prompt.context !== "chat") ctx.current?.chooseScope(q.prompt.context);
      l.setDraft(q.prompt.text);
      area.current?.focus();
    }
  }, [notebookId]);
  useEffect(() => {
    window.addEventListener(PROMPT_EVENT, takeQueued);
    return () => window.removeEventListener(PROMPT_EVENT, takeQueued);
  }, [takeQueued]);
  // On mount (the panel was opened for it) and whenever a send finishes.
  useEffect(() => {
    if (!p.busy) takeQueued();
  }, [p.busy, takeQueued]);
  const voice = useVoice({
    // Anything already typed is sent too: the Mac puts the transcript after it.
    onAudio: (audio, took) => {
      if (p.busy) setError("Still sending the last message. Try the voice message again in a moment.");
      else void send(audio, { "client.pressed": took.releasedAt, "client.recorded": Date.now(), "client.recording_ms": took.durationMs });
    },
    onError: setError,
  });
  // Hold ⌥M to talk, release to send; Esc while holding cancels.
  useEffect(() => {
    if (!p.visible || !voice.supported) return;
    function down(e: KeyboardEvent) {
      if (voice.active() && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        voice.cancel();
        return;
      }
      if (!isTalkKey(e)) return;
      e.preventDefault();
      if (!e.repeat && !voice.active()) {
        setError("");
        voice.start();
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code === "KeyM" || e.key === "Alt") voice.finish();
    }
    const blur = () => voice.cancel();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  });
  const flip = (key: "webSearch" | "allowCode") =>
    p.setSettings({ ...p.settings, options: { ...p.settings.options, [key]: !tools[key] } });
  // In a narrow panel (the iPad's drawing layout) a tool's chip only shows while it is on; the
  // + menu turns tools on and off at any width.
  const toggle = (key: "webSearch" | "allowCode", icon: IconName, label: string, hint: string) => (
    <button
      aria-pressed={tools[key]}
      title={`${hint} ${tools[key] ? "On" : "Off"}.`}
      className={`h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors pointer-coarse:h-10 ${tools[key] ? "flex border-transparent bg-sky-50 text-sky-700" : "hidden border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800 @[34rem]:flex"}`}
      onClick={() => flip(key)}
    >
      <Icon name={icon} />
      <span className="hidden @[26rem]:inline">{label}</span>
    </button>
  );
  const { open: plusOpen, setOpen: setPlusOpen, ref: plusRef } = usePopover();
  const canSend = !!p.draft.trim() && !p.busy;
  const showStop = p.running && !p.draft.trim();
  return (
    <div className="@container shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
      <div
        className={`relative mx-auto max-w-[48rem] rounded-[1.4rem] border bg-white shadow-card transition-[border-color,box-shadow] focus-within:border-slate-300 focus-within:shadow-lift ${dragging ? "border-brand-500 ring-4 ring-brand-100" : "border-slate-200"}`}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.4rem] bg-brand-50/90 text-sm font-medium text-brand-700">
            Drop images or PDFs to attach
          </div>
        )}
        {/* What goes with the message, chosen in one press (ContextPicker). */}
        <div className="flex min-w-0 items-center gap-1 border-b border-slate-100 px-2 py-1.5">
          <ContextPicker {...p} ref={ctx} />
        </div>
        {voice.state !== "idle" && (
          <div role="status" className="flex items-start gap-2 px-4 pt-3 text-sm">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-rose-500 motion-reduce:animate-none" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-slate-500">
                {voice.state === "starting" ? "Opening the microphone…" : "Recording · release to send · Esc to cancel"}
              </span>
              <span className="tabular-nums text-slate-900">
                {Math.floor(voice.elapsed / 60)}:{String(voice.elapsed % 60).padStart(2, "0")}
              </span>
            </span>
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {files.map((file, index) => (
              <span
                key={index}
                className="inline-flex max-w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 py-1.5 pl-2 pr-1 text-xs"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500">
                  <Icon name={file.type === "application/pdf" ? "file" : "paperclip"} />
                </span>
                <span className="min-w-0">
                  <span className="block max-w-[10rem] truncate font-medium text-slate-700">{file.name}</span>
                  <span className="text-slate-400">
                    {(file.size / 1000).toFixed(0)} KB{p.busy && ` · ${Math.round(progress)}%`}
                  </span>
                </span>
                <button
                  disabled={p.busy}
                  aria-label={`Remove ${file.name}`}
                  className="icon-btn h-6 w-6"
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                >
                  <Icon name="x" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          data-chat-composer
          aria-label="Message"
          rows={1}
          placeholder="Ask anything about your notes…"
          className="block max-h-[40vh] min-h-[3.25rem] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 text-slate-900 outline-none placeholder:text-slate-400 pointer-coarse:text-base"
          value={p.draft}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (images.length) {
              e.preventDefault();
              addFiles(images);
            }
          }}
          onChange={(e) => p.setDraft(e.target.value)}
          onKeyDown={(e) => {
            const action = composerAction(
              { ...e, isComposing: e.nativeEvent.isComposing },
              !p.draft.trim(),
            );
            if (action !== "none") e.preventDefault();
            if (action === "send") void send();
            if (action === "stop") p.stop();
          }}
        />
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept="image/*,application/pdf"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <div ref={plusRef} className="relative shrink-0">
            <button
              data-popover-trigger
              aria-label="Attach and tools"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              className="icon-btn h-8 w-8 rounded-full aria-expanded:bg-slate-100 pointer-coarse:h-10 pointer-coarse:w-10"
              title="Attach images or PDFs (or paste / drop them), web search, code"
              onClick={() => setPlusOpen(!plusOpen)}
            >
              <Icon name="plus" />
            </button>
            {plusOpen && (
              <div role="menu" className="absolute bottom-full left-0 z-40 mb-2 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lift">
                <MenuItem
                  onClick={() => {
                    setPlusOpen(false);
                    if (!p.busy) picker.current?.click();
                  }}
                >
                  <Icon name="paperclip" /> Attach images or PDFs
                </MenuItem>
                {(
                  [
                    ["webSearch", "globe", "Web search"],
                    ["allowCode", "code", "Run code"],
                  ] as const
                ).map(([key, icon, label]) => (
                  <MenuItem key={key} onClick={() => flip(key)} hint={tools[key] ? "On" : "Off"}>
                    <Icon name={icon} className={tools[key] ? "text-sky-600" : ""} /> {label}
                  </MenuItem>
                ))}
              </div>
            )}
          </div>
          {toggle("webSearch", "globe", "Search", "Web search.")}
          {toggle("allowCode", "code", "Code", "Run code in a sandbox (Claude: Bash; Codex always can).")}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <ModelPicker
              accounts={p.accounts}
              fallback={p.fallbackModels}
              value={p.settings}
              onChange={p.setSettings}
              defaultModel={p.defaultModel}
              setDefaultModel={p.setDefaultModel}
            />
            {voice.supported && (
              <button
                aria-label="Hold to talk"
                title="Hold to talk, release to send (hold ⌥M). Slide off to cancel."
                disabled={p.busy}
                className={`hold-to-talk flex h-8 w-8 shrink-0 touch-none items-center justify-center rounded-full transition-colors pointer-coarse:h-10 pointer-coarse:w-10 ${voice.state === "idle" ? "text-slate-500 hover:bg-slate-100 hover:text-slate-800" : "bg-rose-500 text-white"}`}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setError("");
                  voice.start();
                }}
                onPointerUp={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const inside = e.clientX >= r.left - 24 && e.clientX <= r.right + 24 && e.clientY >= r.top - 24 && e.clientY <= r.bottom + 24;
                  if (inside) voice.finish();
                  else voice.cancel();
                }}
                onPointerCancel={() => voice.cancel()}
              >
                <Icon name="mic" />
              </button>
            )}
            {showStop ? (
              <button
                aria-label="Stop the reply"
                title="Stop (Esc)"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-opacity hover:opacity-85 pointer-coarse:h-10 pointer-coarse:w-10"
                onClick={p.stop}
              >
                <Icon name="stop" className="fill-current" />
              </button>
            ) : (
              <button
                aria-label={p.busy ? "Sending" : "Send"}
                title="Send (Enter)"
                disabled={!canSend}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-[opacity,background-color] hover:opacity-85 disabled:bg-slate-300 disabled:opacity-100 pointer-coarse:h-10 pointer-coarse:w-10"
                onClick={() => void send()}
              >
                {p.busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="send" />}
              </button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="mx-auto mt-1.5 max-w-[48rem] px-2 text-xs text-rose-700">
          {error}
        </p>
      )}
      {failed && (
        <div role="status" className="mx-auto mt-1.5 flex max-w-[48rem] items-center gap-2 px-2 text-xs text-slate-700">
          <span className="min-w-0 flex-1 truncate">Voice message for &ldquo;{failed.prompt.label}&rdquo; not sent.</span>
          <button
            className="btn btn-secondary btn-sm h-9"
            disabled={p.busy}
            onClick={() => {
              const again = failed;
              setFailed(null);
              setError("");
              void sendPrompt(again);
            }}
          >
            Retry
          </button>
          <button className="btn btn-ghost btn-sm h-9" onClick={() => setFailed(null)}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
