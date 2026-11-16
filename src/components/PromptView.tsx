"use client";

import Link from "next/link";
import { useState } from "react";
import { useStoredState } from "@/lib/hooks";
import { buildPrompt } from "@/lib/payload";

const PRESETS = [
  "8 practice problems on the attached lecture, increasing difficulty, with one recap section first.",
  "Turn the attached lecture into annotatable sections: one key result per section, each with a short worked example and space for my own notes.",
  "A 30-minute timed test (4 questions) on the attached material, with marks and time limits per question.",
];

export default function PromptView() {
  const [request, setRequest] = useStoredState("padsync.promptRequest", PRESETS[0]);
  const [copied, setCopied] = useState(false);
  const prompt = buildPrompt(request);

  const copy = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-slate-500">‹ Library</Link>
      <h1 className="mb-1 mt-2 text-2xl font-semibold text-slate-900">AI prompt</h1>
      <p className="mb-6 text-sm text-slate-600">
        Describe what you want, copy the prompt into Claude or ChatGPT together with your lecture files, then paste the reply into{" "}
        <Link href="/import" className="text-blue-700 underline">Import</Link>.
      </p>
      <div className="mb-2 flex flex-wrap gap-2">
        {PRESETS.map((p, i) => (
          <button key={i} onClick={() => setRequest(p)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
            {["Problem set", "Lecture snippets", "Timed test"][i]}
          </button>
        ))}
      </div>
      <textarea
        className="h-28 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm outline-none focus:border-blue-500"
        value={request}
        onChange={(e) => setRequest(e.target.value)}
      />
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Prompt</h2>
        <button onClick={copy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">{prompt}</pre>
    </main>
  );
}
