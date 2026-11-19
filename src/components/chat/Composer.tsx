"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { composerAction, toolsOf, validateAttachments } from "@/lib/chat-ui";
import type { uploadTurnInputs } from "@/lib/chat-api";
import type { CatalogAccount, ChatAgent, ChatOptions } from "@/lib/chat-types";
import {
  ContextPicker,
  type ContextHandle,
  type ContextProps,
} from "./ContextPicker";
import { ModelPicker } from "./ModelPicker";
import { isTalkKey, useVoice } from "./useVoice";
import { Icon, type IconName } from "../Icons";
import { PROMPT_EVENT, takePrompt } from "@/lib/prompts";

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
    accounts: CatalogAccount[];
    fallbackModels: boolean;
    send(
      text: string,
      context: ContextHandle | null,
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
  // A prompt picked from the iPad's prompt menu (prompts.ts): sent with this chat's context, or
  // put in the box to finish when it isn't marked to send, or while a reply is being sent.
  const sendPrompt = (text: string) =>
    p.send(text, ctx.current, [], { onProgress: () => {} }).catch((error) => setError((error as Error).message));
  const latest = useRef({ sendPrompt, setDraft: p.setDraft, busy: p.busy });
  useEffect(() => {
    latest.current = { sendPrompt, setDraft: p.setDraft, busy: p.busy };
  });
  useEffect(() => {
    const take = () => {
      const pr = takePrompt();
      if (!pr) return;
      const l = latest.current;
      if (pr.send && !l.busy) return void l.sendPrompt(pr.text);
      l.setDraft(pr.text);
      area.current?.focus();
    };
    take();
    window.addEventListener(PROMPT_EVENT, take);
    return () => window.removeEventListener(PROMPT_EVENT, take);
  }, []);
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
  const toggle = (key: "webSearch" | "allowCode", icon: IconName, label: string, hint: string) => (
    <button
      aria-pressed={tools[key]}
      title={`${hint} ${tools[key] ? "On" : "Off"}.`}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ${tools[key] ? "border-transparent bg-sky-50 text-sky-700" : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}
      onClick={() => p.setSettings({ ...p.settings, options: { ...p.settings.options, [key]: !tools[key] } })}
    >
      <Icon name={icon} />
      <span className="hidden @[26rem]:inline">{label}</span>
    </button>
  );
  const canSend = !!p.draft.trim() && !p.busy;
  const showStop = p.running && !p.draft.trim();
  return (
    <div className="@container shrink-0 px-3 pb-3 pt-1">
      <div
        className={`relative mx-auto max-w-[48rem] rounded-[1.4rem] border bg-white shadow-card transition-[border-color,box-shadow] focus-within:border-slate-300 focus-within:shadow-lift ${dragging ? "border-brand-500 ring-4 ring-brand-100" : "border-slate-200"}`}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[1.4rem] bg-brand-50/90 text-sm font-medium text-brand-700">
            Drop images or PDFs to attach
          </div>
        )}
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
          className="block max-h-[40vh] min-h-[3.25rem] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 text-slate-900 outline-none placeholder:text-slate-400"
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
          <button
            aria-label="Attach images or PDFs"
            disabled={p.busy}
            className="icon-btn h-8 w-8 shrink-0 rounded-full"
            title="Attach images or PDFs (or paste / drop them)"
            onClick={() => picker.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <ContextPicker {...p} ref={ctx} />
          {toggle("webSearch", "globe", "Search", "Web search.")}
          {toggle("allowCode", "code", "Code", "Run code in a sandbox (Claude: Bash; Codex always can).")}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <ModelPicker
              accounts={p.accounts}
              fallback={p.fallbackModels}
              value={p.settings}
              onChange={p.setSettings}
            />
            {voice.supported && (
              <button
                aria-label="Hold to talk"
                title="Hold to talk, release to send (hold ⌥M). Slide off to cancel."
                disabled={p.busy}
                className={`flex h-8 w-8 shrink-0 touch-none select-none items-center justify-center rounded-full transition-colors ${voice.state === "idle" ? "text-slate-500 hover:bg-slate-100 hover:text-slate-800" : "bg-rose-500 text-white"}`}
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-opacity hover:opacity-85"
                onClick={p.stop}
              >
                <Icon name="stop" className="fill-current" />
              </button>
            ) : (
              <button
                aria-label={p.busy ? "Sending" : "Send"}
                title="Send (Enter)"
                disabled={!canSend}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition-[opacity,background-color] hover:opacity-85 disabled:bg-slate-300 disabled:opacity-100"
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
    </div>
  );
}
