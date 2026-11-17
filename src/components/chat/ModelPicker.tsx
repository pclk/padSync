"use client";
import { useState } from "react";
import { MODELS, EFFORTS } from "@/lib/chat-ui";
import type { ThreadSummary, ThreadPatch } from "@/lib/chat-types";
export function ModelPicker({
  thread,
  patch,
}: {
  thread: ThreadSummary;
  patch(input: ThreadPatch): void;
}) {
  const [custom, setCustom] = useState(false);
  const choices = MODELS[thread.agent];
  const isCustom =
    custom ||
    !choices.some(([value]) => value === (thread.options.model ?? ""));
  function chooseModel(value: string) {
    setCustom(value === "custom");
    if (value !== "custom")
      patch({ options: { ...thread.options, model: value } });
  }
  return (
    <>
      <select
        aria-label="Model"
        value={isCustom ? "custom" : (thread.options.model ?? "")}
        onChange={(e) => chooseModel(e.target.value)}
      >
        {choices.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {isCustom && (
        <input
          aria-label="Custom model"
          placeholder="Model name"
          className="w-32 rounded-md border border-slate-200 bg-white px-1.5 py-1"
          defaultValue={thread.options.model}
          onBlur={(e) =>
            patch({ options: { ...thread.options, model: e.target.value } })
          }
        />
      )}
      <select
        aria-label="Effort"
        value={thread.options.effort ?? ""}
        onChange={(e) =>
          patch({ options: { ...thread.options, effort: e.target.value } })
        }
      >
        <option value="">Default effort</option>
        {EFFORTS[thread.agent].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
    </>
  );
}
