"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Turn } from "@/lib/chat-types";
import type { SectionEntity } from "@/lib/types";
import { editNeedsFork } from "@/lib/chat-ui";
import { renderMarkdown } from "@/lib/markdown";
import { ReturnedFiles } from "@/components/ReturnedFiles";
import { Icon, type IconName } from "../Icons";

function Action({ icon, label, onClick, done }: { icon: IconName; label: string; onClick(): void; done?: boolean }) {
  return (
    <button aria-label={label} title={label} className="icon-btn h-7 w-7 rounded-lg text-[15px]" onClick={onClick}>
      <Icon name={done ? "tick" : icon} />
    </button>
  );
}

/** Copy with a brief tick. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [
    copied,
    (text) =>
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }),
  ];
}

export function Message({
  turn: t,
  notebookId,
  sections,
  action,
  last,
  edit,
  fork,
  queued,
  modelLabel,
}: {
  turn: Turn;
  notebookId: string;
  sections: SectionEntity[];
  last: boolean;
  action(kind: string, turn: Turn): void;
  edit(turn: Turn, question: string): Promise<void>;
  fork(turn: Turn, question: string): Promise<void>;
  queued: boolean;
  modelLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(t.question);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedQ, copyQ] = useCopied();
  const [copiedA, copyA] = useCopied();
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
      b.textContent = "Copy";
      b.className = "chat-code-copy";
      b.setAttribute("aria-label", "Copy code");
      b.onclick = () => {
        void navigator.clipboard
          .writeText(pre.querySelector("code")?.textContent ?? "")
          .then(() => {
            b.textContent = "Copied";
            setTimeout(() => (b.textContent = "Copy"), 1500);
          });
      };
      pre.append(b);
      buttons.push(b);
    });
    return () => buttons.forEach((b) => b.remove());
  }, [t.output]);
  const active = ["queued", "running", "uploading"].includes(t.status);
  const finished = ["done", "error", "cancelled"].includes(t.status);
  const sectionNames = t.context?.sectionIds
    .map((id) => sections.find((section) => section.id === id)?.data.title ?? "Unavailable section")
    .join(", ");
  let status: ReactNode = null;
  if (active && !t.output)
    status = (
      <p role="status" className="chat-thinking flex items-center gap-2 text-sm text-slate-500">
        <span className="chat-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {queued
          ? "Queued after the previous reply"
          : t.status === "uploading"
            ? "Uploading attachments…"
            : t.status === "running"
              ? "Thinking…"
              : "Waiting for the Mac…"}
      </p>
    );
  return (
    <article className="space-y-3">
      {/* You */}
      <div className="group/user flex flex-col items-end gap-1">
        {(t.attachments.length > 0 || t.context) && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {t.context && t.context.scope !== "none" && (
              <details className="text-xs">
                <summary
                  title={sectionNames}
                  className="flex cursor-pointer list-none items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-slate-500 hover:bg-slate-50"
                >
                  <Icon name="layers" /> {t.context.label}
                </summary>
                <p className="mt-1 max-w-xs rounded-lg bg-slate-50 p-2 text-slate-600">
                  {t.context.scope} · {sectionNames || "no sections"} · {t.context.bytes.toLocaleString()} bytes · ~{t.context.tokens.toLocaleString()} tokens
                </p>
              </details>
            )}
            {t.attachments.map((a) => (
              <span key={a.path} className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500">
                <Icon name="paperclip" /> {a.path}
              </span>
            ))}
          </div>
        )}
        {editing ? (
          <div className="w-full max-w-[85%] space-y-2 rounded-3xl bg-slate-100 p-3">
            <textarea
              aria-label="Edit message"
              autoFocus
              className="field min-h-24 resize-y"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (question.trim()) void save();
                }
              }}
            />
            {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
            <div className="flex justify-end gap-2">
              {conflict && (
                <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => void startFork()}>
                  Start a fork with this draft
                </button>
              )}
              <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" disabled={saving || !question.trim()} onClick={() => void save()}>
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-slate-100 px-4 py-2.5 text-[15px] leading-6 text-slate-900">
            {t.question}
          </div>
        )}
        {!editing && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
            <time className="px-1 text-xs text-slate-400" dateTime={t.createdAt}>
              {new Date(t.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </time>
            <Action icon="edit" label="Edit and resend" onClick={() => {
              setQuestion(t.question);
              setEditing(true);
            }} />
            <Action icon="copy" label="Copy message" done={copiedQ} onClick={() => copyQ(t.question)} />
          </div>
        )}
      </div>

      {/* Assistant */}
      <div className="group/reply flex gap-3">
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 text-[13px] ${active ? "text-brand-600" : "text-slate-500"}`}>
          <Icon name="sparkles" className={active ? "animate-pulse motion-reduce:animate-none" : ""} />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-slate-700">{modelLabel}</span>
            {t.options.effort && <span className="text-slate-400">{t.options.effort}</span>}
            {t.status === "cancelled" && <span className="text-slate-400">· stopped</span>}
          </div>
          {status}
          {t.output && (
            <div
              ref={body}
              className="prose-pad chat-prose break-words"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(t.output) }}
            />
          )}
          {t.status === "running" && t.output && <span className="chat-caret" aria-hidden="true" />}
          {t.error && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <Icon name="alert" className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{t.error}</span>
            </div>
          )}
          {t.resultFiles.length > 0 && (
            <ReturnedFiles
              jobId={t.jobId}
              notebookId={notebookId}
              sections={sections}
              count={t.resultFiles.length}
            />
          )}
          <div className={`-ml-1.5 flex items-center gap-0.5 transition-opacity ${last || active || t.status === "error" ? "" : "opacity-0 focus-within:opacity-100 group-hover/reply:opacity-100"}`}>
            {active && (
              <button className="btn btn-ghost btn-sm" onClick={() => action("stop", t)}>
                <Icon name="stop" /> Stop
              </button>
            )}
            {t.status === "error" && (
              <button className="btn btn-secondary btn-sm" onClick={() => action("retry", t)}>
                <Icon name="refresh" /> Retry
              </button>
            )}
            {finished && t.output && <Action icon="copy" label="Copy reply" done={copiedA} onClick={() => copyA(t.output)} />}
            {last && finished && <Action icon="refresh" label="Regenerate" onClick={() => action("regenerate", t)} />}
            {finished && (
              <time className="px-1 text-xs text-slate-400" dateTime={t.updatedAt}>
                {new Date(t.finishedAt ?? t.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </time>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
