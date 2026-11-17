"use client";
import { useEffect, useRef } from "react";
import type { Turn } from "@/lib/chat-types";
import type { SectionEntity } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { ReturnedFiles } from "@/components/ReturnedFiles";
export function Message({ turn: t, notebookId, sections, action, last }: { turn: Turn; notebookId: string; sections: SectionEntity[]; last: boolean; action(kind: string, turn: Turn): void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons: HTMLButtonElement[] = [];
    body.current?.querySelectorAll("pre").forEach((pre) => { const b = document.createElement("button"); b.textContent = "Copy code"; b.className = "block text-xs text-blue-700"; b.onclick = () => { void navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "").then(() => { b.textContent = "Copied"; }); }; pre.append(b); buttons.push(b); });
    return () => buttons.forEach((b) => b.remove());
  }, [t.output]);
  return <article className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex justify-between text-xs text-slate-500"><span>You</span><time>{new Date(t.createdAt).toLocaleTimeString()}</time></div>
    <p className="whitespace-pre-wrap">{t.question}</p>{t.context && <details><summary className="text-xs text-slate-500">{t.context.label}</summary><p>{t.context.sectionIds.join(", ")} · {t.context.bytes} bytes</p></details>}
    {t.attachments.map((a) => <span key={a.path} className="mr-1 text-xs">📎 {a.path}</span>)}
    <button className="text-xs text-blue-700" onClick={() => action("edit", t)}>Edit & resend</button>
    <div className="border-t pt-2 text-xs text-slate-500">{[t.agent, t.options.model, t.options.effort, t.status].filter(Boolean).join(" · ")}</div>
    <div ref={body} className="prose-pad break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.output) }} />
    {t.error && <p role="alert" className="text-rose-700">{t.error}</p>}
    {t.resultFiles.length > 0 && <ReturnedFiles jobId={t.jobId} notebookId={notebookId} sections={sections} count={t.resultFiles.length} />}
    <div className="flex gap-3 text-xs text-blue-700">{["queued", "running", "uploading"].includes(t.status) && <button onClick={() => action("stop", t)}>Stop</button>}{t.status === "error" && <button onClick={() => action("retry", t)}>Retry</button>}{last && ["done", "error", "cancelled"].includes(t.status) && <button onClick={() => action("regenerate", t)}>Regenerate</button>}<button onClick={() => action("copy", t)}>Copy</button></div>
  </article>;
}
