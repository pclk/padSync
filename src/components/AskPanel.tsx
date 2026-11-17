"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Selection } from "@/ink/controller";
import { addRenders, cropSelection, gatherSections } from "@/lib/ask-bundle";
import { DEFAULT_CONTEXT, buildBundle, bundleSignature, jobRequestBody, kb, pickSections, type Bundle, type ContextOptions, type SelectionInput } from "@/lib/context";
import { sectionSource } from "@/lib/export";
import { useStoredState } from "@/lib/hooks";
import { renderMarkdown } from "@/lib/markdown";
import { logEvent } from "@/lib/store";
import type { SectionEntity } from "@/lib/types";
import { BundlePreview, ContextControls, type TextSelection } from "./ContextControls";
import { ReturnedFiles } from "./ReturnedFiles";

// "Ask AI": queues a job on the server; the bridge on the Mac runs Claude Code / Codex and
// streams the answer back. Works from any signed-in device; answers wait if the Mac is offline.
// What the AI gets is a bundle of files (src/lib/context.ts) chosen under "What to send"; the
// bridge writes it into a temp folder and the agent reads it with its own tools.

type Agent = "claude" | "codex";

interface JobOptions {
  model?: string;
  effort?: string;
  webSearch?: boolean;
}

// Choices offered per agent; "" leaves it to the agent's own default (its config on the Mac).
const MODELS: Record<Agent, [string, string][]> = {
  claude: [["", "Default model"], ["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]],
  codex: [["", "Default model"], ["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-6.1-terra", "GPT-6.1 Terra"], ["gpt-6-astra", "GPT-6 Astra"], ["gpt-6-sol", "GPT-6 Sol"], ["gpt-6-luna", "GPT-6 Luna"]],
};
const EFFORTS: Record<Agent, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

interface Job {
  id: string;
  agent: Agent;
  question: string;
  options?: JobOptions;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  output: string;
  error: string | null;
  createdAt: string;
  resultFiles?: { path: string; mime: string; size: number }[];
}

const BRIDGE_ONLINE_MS = 30_000;
/** Rough cost of one section render in the summary, before anything is rendered. */
const RENDER_TOKENS_GUESS = 1200;

interface Prepared {
  sig: string;
  bundle: Bundle;
}

async function fetchJobs(sectionId: string) {
  const res = await fetch(`/api/jobs?sectionId=${encodeURIComponent(sectionId)}`).catch(() => null);
  return res?.ok ? ((await res.json()) as { jobs: Job[]; bridgeSeenAt: string | null }) : null;
}

interface Props {
  notebookId: string;
  notebookTitle: string;
  sections: SectionEntity[];
  section: SectionEntity;
  sectionEl: (id: string) => HTMLElement | undefined;
  /** The editor's lasso selection, if any. */
  lasso: Selection | null;
}

export function AskPanel({ notebookId, notebookTitle, sections, section, sectionEl, lasso }: Props) {
  const [agent, setAgent] = useStoredState<Agent>("padsync.agent", "claude");
  const [storedCtx, setStoredCtx] = useStoredState<Partial<ContextOptions>>("padsync.askContext", DEFAULT_CONTEXT);
  const [storedIds, setPickedIds] = useStoredState<string[] | null>(`padsync.askSections.${notebookId}`, null);
  const [showContext, setShowContext] = useStoredState("padsync.askShowContext", false);
  const [textSel, setTextSel] = useState<TextSelection | null>(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<Prepared | null>(null);
  const [summary, setSummary] = useState("");
  const [allOptions, setAllOptions] = useStoredState<Record<Agent, JobOptions>>("padsync.askOptions", { claude: {}, codex: {} });
  const options = allOptions[agent] ?? {};
  const setOption = (o: JobOptions) => setAllOptions({ ...allOptions, [agent]: { ...options, ...o } });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [bridgeSeenAt, setBridgeSeenAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((data: { jobs: Job[]; bridgeSeenAt: string | null } | null) => {
    if (!data) return;
    setJobs(data.jobs);
    setBridgeSeenAt(data.bridgeSeenAt);
    setNow(Date.now());
  }, []);
  const refresh = useCallback(() => fetchJobs(section.id).then(apply), [section.id, apply]);

  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    fetchJobs(section.id).then(apply);
    const t = setInterval(() => document.visibilityState === "visible" && fetchJobs(section.id).then(apply), active ? 1500 : 8000);
    return () => clearInterval(t);
  }, [section.id, apply, active]);

  // Stored settings are merged over the defaults so options added later get their default.
  const pickedIds = useMemo(() => (storedIds ?? sections.map((s) => s.id)).filter((id) => sections.some((s) => s.id === id)), [storedIds, sections]);
  const ctx: ContextOptions = useMemo(() => ({ ...DEFAULT_CONTEXT, ...storedCtx, sectionIds: pickedIds }), [storedCtx, pickedIds]);
  const setCtx = (patch: Partial<ContextOptions>) => setStoredCtx({ ...storedCtx, ...patch, sectionIds: [] });
  const lassoHere = lasso && lasso.sectionId === section.id && lasso.ids.size ? lasso : null;
  const selectionKey = useMemo(
    () => (ctx.scope === "selection" ? [section.id, textSel?.text ?? "", lassoHere ? [lassoHere.box, [...lassoHere.ids].sort()] : null] : null),
    [ctx.scope, section.id, textSel, lassoHere],
  );

  useEffect(() => {
    let live = true;
    void sectionSource(section, false).then((t) => live && setSource(t));
    return () => {
      live = false;
    };
  }, [section]);

  // Summary before anything is rendered: exact for text, a guess for renders.
  useEffect(() => {
    let live = true;
    void gatherSections(sections).then((inputs) => {
      if (!live) return;
      const selection: SelectionInput | null = selectionKey ? { sectionId: section.id, text: textSel?.text, crop: lassoHere ? { base64: "", width: 600, height: 400 } : null } : null;
      const b = buildBundle({ title: notebookTitle, sections: inputs, selection }, { ...ctx, renders: false });
      if (b.error) return setSummary(b.error);
      const renders = ctx.renders && ctx.scope !== "selection" ? pickSections(inputs, ctx, selection).length : 0;
      const n = b.sectionIds.length;
      setSummary(
        [
          ctx.scope === "selection" ? "selection only" : `${n} section${n === 1 ? "" : "s"}`,
          renders ? `${renders} render${renders === 1 ? "" : "s"}` : null,
          `~${(b.tokens + renders * RENDER_TOKENS_GUESS).toLocaleString()} tokens`,
          `${kb(b.bytes)} text`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    });
    return () => {
      live = false;
    };
  }, [sections, notebookTitle, ctx, selectionKey, section.id, textSel, lassoHere]);

  /** Builds the bundle exactly as it would be sent, plus a signature of everything it used. */
  const prepare = async (): Promise<Prepared> => {
    const inputs = await gatherSections(sections);
    let selection: SelectionInput | null = null;
    if (ctx.scope === "selection") {
      const el = sectionEl(section.id);
      const crop = lassoHere && el ? await cropSelection(section, el, lassoHere.box) : null;
      selection = { sectionId: section.id, text: textSel?.text, crop };
    }
    const withRenders = await addRenders(inputs, sections, ctx, sectionEl, selection);
    return { sig: bundleSignature(notebookTitle, inputs, selectionKey, ctx), bundle: buildBundle({ title: notebookTitle, sections: withRenders, selection }, ctx) };
  };

  const showPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await prepare());
    } catch (e) {
      setError(`Couldn't build the preview: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let bundle: Bundle;
      if (preview) {
        // Send what was previewed, or nothing: if anything changed, show the new version first.
        const sig = bundleSignature(notebookTitle, await gatherSections(sections), selectionKey, ctx);
        if (sig !== preview.sig) {
          setPreview(await prepare());
          setError("The notebook or the options changed since the preview. Check it again, then send.");
          return;
        }
        bundle = preview.bundle;
      } else bundle = (await prepare()).bundle;
      if (bundle.error) return setError(bundle.error);
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jobRequestBody({ notebookId, sectionId: section.id, agent, question, options }, bundle, ctx)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? "Sign in on the Settings page first." : res.status === 503 ? "Server database is not set up." : (data.error ?? `Failed (${res.status})`));
        return;
      }
      setQuestion("");
      setPreview(null);
      void logEvent(notebookId, section.id, "ask", { jobId: data.job.id, agent, scope: ctx.scope, sections: bundle.sectionIds.length, bytes: bundle.bytes });
      await refresh();
    } catch (e) {
      setError(navigator.onLine ? (e as Error).message : "You're offline; asking needs a connection.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    await refresh();
  };

  const copy = async (j: Job) => {
    try {
      await navigator.clipboard.writeText(j.output);
    } catch {
      return setError("Couldn't copy: the browser blocked clipboard access.");
    }
    setCopiedId(j.id);
    setTimeout(() => setCopiedId((id) => (id === j.id ? null : id)), 1600);
  };

  const bridgeOnline = bridgeSeenAt && now - new Date(bridgeSeenAt).getTime() < BRIDGE_ONLINE_MS;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ask AI</h3>
        <span className={`flex items-center gap-1.5 text-xs ${bridgeOnline ? "text-emerald-700" : "text-slate-400"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${bridgeOnline ? "bg-emerald-500" : "bg-slate-300"}`} />
          {bridgeOnline ? "Mac bridge online" : "Mac bridge offline"}
        </span>
      </div>
      <textarea
        className="h-20 w-full resize-none rounded-lg border border-slate-300 bg-white p-2 outline-none focus:border-blue-500"
        placeholder="Is my working right? Where did I go wrong?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void ask();
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1.5" value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <button className="ml-auto shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs disabled:opacity-40" disabled={busy} onClick={showPreview}>
          Preview
        </button>
        <button className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-40" disabled={busy || !question.trim()} onClick={ask}>
          {busy ? "Sending…" : "Ask ⌘↵"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1" value={options.model ?? ""} onChange={(e) => setOption({ model: e.target.value || undefined })} aria-label="Model">
          {MODELS[agent].map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
          {options.model && !MODELS[agent].some(([v]) => v === options.model) && <option value={options.model}>{options.model}</option>}
        </select>
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1" value={options.effort ?? ""} onChange={(e) => setOption({ effort: e.target.value || undefined })} aria-label="Thinking effort">
          <option value="">Default effort</option>
          {EFFORTS[agent].map((v) => (
            <option key={v} value={v}>
              {v} effort
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-slate-600" title="Let the agent search and read the web.">
          <input type="checkbox" checked={!!options.webSearch} onChange={(e) => setOption({ webSearch: e.target.checked })} /> web search
        </label>
      </div>
      <div className="mt-2">
        <button className="flex w-full items-center gap-1 text-xs text-slate-600" onClick={() => setShowContext(!showContext)} aria-expanded={showContext}>
          <span>{showContext ? "▾" : "▸"}</span>
          <span className="font-medium">What to send</span>
          {!showContext && <span className="ml-1 truncate text-slate-400">{summary}</span>}
        </button>
        {showContext && (
          <div className="mt-1">
            <ContextControls
              o={ctx}
              set={setCtx}
              sections={sections}
              pickedIds={pickedIds}
              setPickedIds={setPickedIds}
              currentId={section.id}
              source={source}
              textSel={textSel}
              setTextSel={setTextSel}
              lassoCount={lassoHere?.ids.size ?? 0}
              summary={summary}
            />
          </div>
        )}
      </div>
      {preview && <BundlePreview bundle={preview.bundle} onClose={() => setPreview(null)} />}
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}

      <ul className="mt-3 space-y-3">
        {jobs.map((j) => (
          <li key={j.id} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{j.agent === "claude" ? "Claude Code" : "Codex"}</span>
              {(j.options?.model || j.options?.effort) && <span>{[j.options.model, j.options.effort].filter(Boolean).join(" · ")}</span>}
              <StatusChip status={j.status} />
              <span className="ml-auto">{new Date(j.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p className="mb-2 text-slate-600">{j.question}</p>
            {j.output && <div className="prose-pad border-t border-slate-100 pt-2" dangerouslySetInnerHTML={{ __html: renderMarkdown(j.output) }} />}
            {j.status === "queued" && !bridgeOnline && <p className="text-xs text-slate-400">Waiting for the bridge on your Mac.</p>}
            {j.error && <p className="mt-1 text-xs text-rose-700">{j.error}</p>}
            {j.status === "done" && !!j.resultFiles?.length && <ReturnedFiles jobId={j.id} notebookId={notebookId} sections={sections} count={j.resultFiles.length} />}
            <div className="mt-2 flex gap-2 text-xs">
              {(j.status === "queued" || j.status === "running") && (
                <button className="text-rose-600" onClick={() => cancel(j.id)}>
                  Cancel
                </button>
              )}
              {j.output && (
                <button
                  className={`copy-btn rounded px-1 transition-colors duration-200 ${copiedId === j.id ? "copied bg-emerald-100 text-emerald-700" : "text-blue-700"}`}
                  onClick={() => copy(j)}
                  aria-live="polite"
                >
                  {copiedId === j.id ? "✓ Copied" : "Copy answer"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusChip({ status }: { status: Job["status"] }) {
  const style: Record<Job["status"], string> = {
    queued: "bg-slate-100 text-slate-600",
    running: "bg-amber-100 text-amber-800",
    done: "bg-emerald-100 text-emerald-800",
    error: "bg-rose-100 text-rose-800",
    cancelled: "bg-slate-100 text-slate-400",
  };
  return <span className={`rounded px-1.5 py-0.5 ${style[status]}`}>{status}</span>;
}
