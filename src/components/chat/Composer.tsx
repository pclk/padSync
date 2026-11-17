"use client";
import { useRef, useState } from "react";
import { composerAction } from "@/lib/chat-ui";
import { ContextPicker, type ContextHandle, type ContextProps } from "./ContextPicker";
export function Composer(p: ContextProps & { draft: string; setDraft(s: string): void; busy: boolean; send(text: string, context: ContextHandle | null): Promise<void>; stop(): void }) {
  const ctx = useRef<ContextHandle>(null);
  const [error, setError] = useState("");
  const send = () => { if (p.draft.trim() && !p.busy) void p.send(p.draft, ctx.current).catch((e) => setError(String(e))); };
  return <div className="shrink-0 space-y-2 border-t bg-slate-50 p-3"><ContextPicker {...p} ref={ctx} /><textarea data-chat-composer aria-label="Message" placeholder="Ask a question…" className="max-h-[40vh] min-h-20 w-full resize-y rounded-lg border border-slate-300 bg-white p-2" value={p.draft} onChange={(e) => { p.setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }} onKeyDown={(e) => { const action = composerAction({ ...e, isComposing: e.nativeEvent.isComposing }, !p.draft.trim()); if (action !== "none") e.preventDefault(); if (action === "send") send(); if (action === "stop") p.stop(); }} /><button className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-40" disabled={p.busy || !p.draft.trim()} onClick={send}>Ask ⌘↵</button>{error && <p role="alert" className="text-xs text-rose-700">{error}</p>}</div>;
}
