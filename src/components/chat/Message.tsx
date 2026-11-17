"use client";
import { useEffect, useRef, useState } from "react";
import type { Turn } from "@/lib/chat-types";
import type { SectionEntity } from "@/lib/types";
import { editNeedsFork } from "@/lib/chat-ui";
import { Spinner } from "./Spinner";
import { renderMarkdown } from "@/lib/markdown";
import { ReturnedFiles } from "@/components/ReturnedFiles";
export function Message({
  turn: t,
  notebookId,
  sections,
  action,
  last,
  edit,
  fork,
  queued,
}: {
  turn: Turn;
  notebookId: string;
  sections: SectionEntity[];
  last: boolean;
  action(kind: string, turn: Turn): void;
  edit(turn: Turn, question: string): Promise<void>;
  fork(turn: Turn, question: string): Promise<void>;
  queued: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(t.question);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      await edit(t, question);
      setEditing(false);
    } catch (error) {
      setError((error as Error).message);
      setConflict(editNeedsFork(error));
    } finally {
      setSaving(false);
    }
  }
  async function startFork() {
    setSaving(true);
    try {
      await fork(t, question);
      setEditing(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons: HTMLButtonElement[] = [];
    body.current?.querySelectorAll("pre").forEach((pre) => {
      const b = document.createElement("button");
      b.textContent = "Copy code";
      b.className = "block text-xs text-blue-700";
      b.onclick = () => {
        void navigator.clipboard
          .writeText(pre.querySelector("code")?.textContent ?? "")
          .then(() => {
            b.textContent = "Copied";
          });
      };
      pre.append(b);
      buttons.push(b);
    });
    return () => buttons.forEach((b) => b.remove());
  }, [t.output]);
  return (
    <article className="space-y-3">
      <div className="ml-auto max-w-[92%] space-y-2 rounded-2xl rounded-br-md bg-brand-50 px-3.5 py-2.5 text-slate-800">
        <div className="flex justify-between text-xs text-slate-500">
          <span>You</span>
          <time>{new Date(t.createdAt).toLocaleTimeString()}</time>
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              aria-label="Edit message"
              className="min-h-24 w-full rounded-lg border bg-white p-2"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="flex gap-3">
              <button
                disabled={saving || !question.trim()}
                onClick={() => void save()}
              >
                Save & send
              </button>
              <button disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
            {conflict && (
              <button disabled={saving} onClick={() => void startFork()}>
                Start fork with this draft
              </button>
            )}
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{t.question}</p>
        )}
        {t.context && (
          <details>
            <summary className="text-xs text-slate-500">
              {t.context.label}
            </summary>
            <p>
              {t.context.scope} ·{" "}
              {t.context.sectionIds
                .map(
                  (id) =>
                    sections.find((section) => section.id === id)?.data.title ??
                    "Unavailable section",
                )
                .join(", ")}{" "}
              · {t.context.bytes.toLocaleString()} bytes · ~
              {t.context.tokens.toLocaleString()} tokens
            </p>
          </details>
        )}
        {t.attachments.map((a) => (
          <span key={a.path} className="mr-1 text-xs">
            📎 {a.path}
          </span>
        ))}
        <button
          className="text-xs text-blue-700"
          onClick={() => {
            setQuestion(t.question);
            setEditing(true);
          }}
        >
          Edit & resend
        </button>
        <button
          className="ml-3 text-xs text-blue-700"
          onClick={() => void navigator.clipboard.writeText(t.question)}
        >
          Copy message
        </button>
      </div>
      <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-card">
        <div className="border-t pt-2 text-xs text-slate-500">
          {[t.agent, t.options.model, t.options.effort, t.status]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {["queued", "running", "uploading"].includes(t.status) && (
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-slate-500"
          >
            <Spinner />
            {queued
              ? "Queued after the previous reply"
              : t.status === "running"
                ? "Writing a reply…"
                : t.status === "uploading"
                  ? "Uploading attachments…"
                  : "Waiting for a reply…"}
          </p>
        )}
        <time className="text-xs text-slate-400" dateTime={t.updatedAt}>
          {new Date(t.updatedAt).toLocaleTimeString()}
        </time>
        <div
          ref={body}
          className="prose-pad break-words"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(t.output) }}
        />
        {t.error && (
          <p role="alert" className="text-rose-700">
            {t.error}
          </p>
        )}
        {t.resultFiles.length > 0 && (
          <ReturnedFiles
            jobId={t.jobId}
            notebookId={notebookId}
            sections={sections}
            count={t.resultFiles.length}
          />
        )}
        <div className="flex gap-3 text-xs text-blue-700">
          {["queued", "running", "uploading"].includes(t.status) && (
            <button onClick={() => action("stop", t)}>Stop</button>
          )}
          {t.status === "error" && (
            <button onClick={() => action("retry", t)}>Retry</button>
          )}
          {last && ["done", "error", "cancelled"].includes(t.status) && (
            <button onClick={() => action("regenerate", t)}>Regenerate</button>
          )}
          <button onClick={() => action("copy", t)}>Copy</button>
        </div>
      </div>
    </article>
  );
}
