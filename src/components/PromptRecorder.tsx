"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatPrompt } from "@/lib/prompts";
import { MIN_HOLD_MS, useVoice } from "./chat/useVoice";
import { Icon } from "./Icons";

/**
 * Records the voice message of a prompt picked from the prompt menu: it starts at once, and Send
 * hands the recording on (with the prompt's text) while Cancel drops it. Tapped rather than held,
 * so the hand that picked the prompt is free again while you talk.
 */
export function PromptRecorder({ prompt, onAudio, onClose }: { prompt: ChatPrompt; onAudio: (audio: Blob) => void; onClose: () => void }) {
  const [error, setError] = useState("");
  const startedAt = useRef(0);
  const voice = useVoice({
    onAudio: (audio) => {
      onAudio(audio);
      onClose();
    },
    onError: setError,
  });
  const { start, cancel } = voice;
  useEffect(() => {
    if (voice.state === "recording") startedAt.current = Date.now();
  }, [voice.state]);
  useEffect(() => {
    void start();
    return () => cancel();
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An error (microphone blocked, nothing recorded) shows for a moment, then the bar goes.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [error, onClose]);

  const send = () => {
    // useVoice treats a very short recording as a slip and drops it; say so in these words.
    if (Date.now() - startedAt.current < MIN_HOLD_MS + 50) return setError("Too short to send. Pick the prompt again and speak for longer.");
    voice.finish();
  };
  const { elapsed } = voice;
  return (
    <div role="dialog" aria-label={`Recording: ${prompt.label}`} className="fixed inset-x-0 top-[4.25rem] z-50 flex justify-center px-3">
      <div className="card flex max-w-full items-center gap-3 py-2 pl-4 pr-2 shadow-lift">
        {error ? (
          <p role="alert" className="text-sm text-rose-700">{error}</p>
        ) : (
          <>
            <span className={`h-3 w-3 shrink-0 rounded-full ${voice.state === "recording" ? "animate-pulse bg-rose-500" : "bg-slate-300"}`} aria-hidden="true" />
            <span className="min-w-0 truncate text-sm text-slate-800">
              {voice.state === "recording" ? prompt.label : "Opening the microphone…"}
            </span>
            <span className="tabular-nums text-sm text-slate-500">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
            <button className="btn btn-ghost h-11 px-3" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary h-11 px-4" disabled={voice.state !== "recording"} onClick={send}>
              <Icon name="send" /> Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
