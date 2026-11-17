"use client";
import { useEffect, useRef, useState } from "react";
import { composerAction, validateAttachments } from "@/lib/chat-ui";
import type { uploadTurnInputs } from "@/lib/chat-api";
import {
  ContextPicker,
  type ContextHandle,
  type ContextProps,
} from "./ContextPicker";
export function Composer(
  p: ContextProps & {
    draft: string;
    setDraft(s: string): void;
    busy: boolean;
    send(
      text: string,
      context: ContextHandle | null,
      files: File[],
      progress: Parameters<typeof uploadTurnInputs>[2],
    ): Promise<void>;
    stop(): void;
  },
) {
  const ctx = useRef<ContextHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
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
  useEffect(() => {
    const panel = picker.current?.closest("[data-chat-root]");
    function drag(event: Event) {
      const e = event as DragEvent;
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    function drop(event: Event) {
      const e = event as DragEvent;
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      addFiles(Array.from(e.dataTransfer.files));
    }
    panel?.addEventListener("dragover", drag);
    panel?.addEventListener("drop", drop);
    return () => {
      panel?.removeEventListener("dragover", drag);
      panel?.removeEventListener("drop", drop);
    };
  });
  async function send() {
    if (!p.draft.trim() || p.busy) return;
    setError("");
    setProgress(0);
    try {
      await p.send(p.draft, ctx.current, files, {
        onProgress: (sent: number, total: number) =>
          setProgress(total ? (sent / total) * 100 : 100),
      });
      setFiles([]);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <div className="shrink-0 space-y-2 border-t bg-slate-50 p-3">
      <ContextPicker {...p} ref={ctx} />
      <div className="flex flex-wrap gap-1">
        {files.map((file, index) => (
          <span key={index} className="rounded-lg border bg-white p-2 text-xs">
            {file.name} · {(file.size / 1000).toFixed(0)} KB{" "}
            {p.busy && `${Math.round(progress)}%`}
            <button
              disabled={p.busy}
              aria-label={`Remove ${file.name}`}
              className="ml-2"
              onClick={() => setFiles(files.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <textarea
        data-chat-composer
        aria-label="Message"
        placeholder="Ask a question…"
        className="max-h-[40vh] min-h-20 w-full resize-y rounded-lg border border-slate-300 bg-white p-2"
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
        onChange={(e) => {
          p.setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
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
      <div className="flex gap-2">
        <button
          aria-label="Attach images or PDFs"
          disabled={p.busy}
          className="rounded-lg border bg-white px-3 py-2"
          onClick={() => picker.current?.click()}
        >
          📎
        </button>
        <button
          className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
          disabled={p.busy || !p.draft.trim()}
          onClick={() => void send()}
        >
          {p.busy ? "Sending…" : "Ask ⌘↵"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
