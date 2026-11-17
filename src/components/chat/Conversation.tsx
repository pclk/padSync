"use client";
import { useEffect, useRef, useState } from "react";
import type { Turn } from "@/lib/chat-types";
import type { SectionEntity } from "@/lib/types";
import { hasNewOutput, queuedAfterPrevious } from "@/lib/chat-ui";
import { Message } from "./Message";
export function Conversation(p: {
  turns: Turn[];
  notebookId: string;
  sections: SectionEntity[];
  action(kind: string, turn: Turn): void;
  edit(turn: Turn, question: string): Promise<void>;
  fork(turn: Turn, question: string): Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newText, setNewText] = useState(false);
  const previous = useRef<Turn[]>([]);
  useEffect(() => {
    const arrived = hasNewOutput(previous.current, p.turns);
    previous.current = p.turns;
    if (atBottom.current && box.current)
      box.current.scrollTop = box.current.scrollHeight;
    else if (arrived) setNewText(true);
  }, [p.turns]);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={box}
        className="h-full space-y-3 overflow-y-auto p-3"
        onScroll={() => {
          const el = box.current!;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (atBottom.current) setNewText(false);
        }}
      >
        {!p.turns.length && (
          <p className="py-10 text-center text-slate-500">
            Ask a question about your notebook.
          </p>
        )}
        {p.turns.map((t, i) => (
          <Message
            key={t.jobId}
            turn={t}
            notebookId={p.notebookId}
            sections={p.sections}
            action={p.action}
            edit={p.edit}
            fork={p.fork}
            queued={queuedAfterPrevious(t, p.turns)}
            last={i === p.turns.length - 1}
          />
        ))}
        <span className="sr-only" aria-live="polite">
          {p.turns.filter((t) => t.status === "done").length} replies finished
        </span>
      </div>
      {newText && (
        <button
          className="absolute bottom-2 right-3 rounded-lg bg-slate-900 px-3 py-1 text-white"
          onClick={() => {
            box.current!.scrollTop = box.current!.scrollHeight;
            atBottom.current = true;
            setNewText(false);
          }}
        >
          ↓ New text
        </button>
      )}
    </div>
  );
}
