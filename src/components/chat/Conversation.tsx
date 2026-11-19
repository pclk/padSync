"use client";
import { useEffect, useRef, useState } from "react";
import type { ChatAgent, ChatOptions, Turn } from "@/lib/chat-types";
import type { SectionEntity } from "@/lib/types";
import { hasNewOutput, queuedAfterPrevious } from "@/lib/chat-ui";
import { turnCost, type Price } from "@/lib/chat-cost";
import { Message } from "./Message";
import { Icon } from "../Icons";

const SUGGESTIONS = [
  "Explain this step by step",
  "Check my working",
  "Quiz me on this",
  "Summarise the key ideas",
];

export function Conversation(p: {
  turns: Turn[];
  notebookId: string;
  sections: SectionEntity[];
  action(kind: string, turn: Turn): void;
  edit(turn: Turn, question: string): Promise<void>;
  fork(turn: Turn, question: string): Promise<void>;
  modelLabel(s: { agent: ChatAgent; options: ChatOptions }): string;
  priceOf(s: { agent: ChatAgent; options: ChatOptions }): Price | null;
  /** Fills the composer from an empty-state suggestion. */
  suggest(text: string): void;
  loading: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newText, setNewText] = useState(false);
  const previous = useRef<Turn[]>([]);
  useEffect(() => {
    const arrived = hasNewOutput(previous.current, p.turns);
    const sentNew = p.turns.length > previous.current.length;
    previous.current = p.turns;
    if ((atBottom.current || sentNew) && box.current) {
      box.current.scrollTop = box.current.scrollHeight;
      atBottom.current = true;
    } else if (arrived) setNewText(true);
  }, [p.turns]);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={box}
        className="h-full overflow-y-auto"
        onScroll={() => {
          const el = box.current!;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (atBottom.current) setNewText(false);
        }}
      >
        {!p.turns.length && !p.loading ? (
          <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
            <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-xl text-brand-600">
              <Icon name="sparkles" />
            </span>
            <h2 className="text-lg font-semibold text-slate-900">What are we working on?</h2>
            <p className="mt-1 max-w-xs text-sm text-slate-500">
              Ask about the page you are writing on. The section the iPad is on is sent along by default.
            </p>
            <div className="mt-5 flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-card transition-colors hover:bg-slate-50 hover:text-slate-900"
                  onClick={() => p.suggest(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[48rem] space-y-8 px-4 py-6">
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
                modelLabel={p.modelLabel(t)}
                cost={turnCost(p.turns, i, p.priceOf(t))}
              />
            ))}
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {p.turns.filter((t) => t.status === "done").length} replies finished
        </span>
      </div>
      {newText && (
        <button
          aria-label="Scroll to the new text"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-lift"
          onClick={() => {
            box.current!.scrollTop = box.current!.scrollHeight;
            atBottom.current = true;
            setNewText(false);
          }}
        >
          <Icon name="arrowDown" /> New text
        </button>
      )}
    </div>
  );
}
