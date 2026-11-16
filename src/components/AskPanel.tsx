"use client";

import { useCallback, useEffect, useState } from "react";
import { sectionPng, sectionSource } from "@/lib/export";
import { useStoredState } from "@/lib/hooks";
import { renderMarkdown } from "@/lib/markdown";
import { logEvent } from "@/lib/store";
import type { SectionEntity } from "@/lib/types";

// "Ask AI": queues a job on the server; the bridge on the Mac runs Claude Code / Codex and
// streams the answer back. Works from any signed-in device; answers wait if the Mac is offline.

type Agent = "claude" | "codex";

interface Job {
  id: string;
  agent: Agent;
  question: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  output: string;
  error: string | null;
  createdAt: string;
}

const MAX_IMAGE_CHARS = 3_000_000;
const BRIDGE_ONLINE_MS = 30_000;

async function fetchJobs(sectionId: string) {
  const res = await fetch(`/api/jobs?sectionId=${encodeURIComponent(sectionId)}`).catch(() => null);
  return res?.ok ? ((await res.json()) as { jobs: Job[]; bridgeSeenAt: string | null }) : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function AskPanel({ notebookId, section, sectionEl }: { notebookId: string; section: SectionEntity; sectionEl: () => HTMLElement | undefined }) {
  const [agent, setAgent] = useStoredState<Agent>("padsync.agent", "claude");
  const [withSolution, setWithSolution] = useStoredState("padsync.askWithSolution", true);
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

  const ask = async () => {
    const el = sectionEl();
    if (!question.trim() || !el) return;
    setBusy(true);
    setError(null);
    try {
      let image = await blobToDataUrl(await sectionPng(section, el, 2));
      if (image.length > MAX_IMAGE_CHARS) image = await blobToDataUrl(await sectionPng(section, el, 1));
      if (image.length > MAX_IMAGE_CHARS) image = "";
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notebookId,
          sectionId: section.id,
          agent,
          question,
          context: await sectionSource(section, withSolution),
          image: image || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? "Sign in on the Settings page first." : res.status === 503 ? "Server database is not set up." : (data.error ?? `Failed (${res.status})`));
        return;
      }
      setQuestion("");
      void logEvent(notebookId, section.id, "ask", { jobId: data.job.id, agent });
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

  const bridgeOnline = bridgeSeenAt && now - new Date(bridgeSeenAt).getTime() < BRIDGE_ONLINE_MS;

  return (
    <div className="mt-4">
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
        {section.data.solution && (
          <label className="flex items-center gap-1 text-xs text-slate-600" title="The AI sees the hidden solution and is told not to reveal it unless you ask.">
            <input type="checkbox" checked={withSolution} onChange={(e) => setWithSolution(e.target.checked)} /> use solution
          </label>
        )}
        <button className="ml-auto rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white disabled:opacity-40" disabled={busy || !question.trim()} onClick={ask}>
          {busy ? "Sending…" : "Ask ⌘↵"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}

      <ul className="mt-3 space-y-3">
        {jobs.map((j) => (
          <li key={j.id} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{j.agent === "claude" ? "Claude Code" : "Codex"}</span>
              <StatusChip status={j.status} />
              <span className="ml-auto">{new Date(j.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p className="mb-2 text-slate-600">{j.question}</p>
            {j.output && <div className="prose-pad border-t border-slate-100 pt-2" dangerouslySetInnerHTML={{ __html: renderMarkdown(j.output) }} />}
            {j.status === "queued" && !bridgeOnline && <p className="text-xs text-slate-400">Waiting for the bridge on your Mac.</p>}
            {j.error && <p className="mt-1 text-xs text-rose-700">{j.error}</p>}
            <div className="mt-2 flex gap-2 text-xs">
              {(j.status === "queued" || j.status === "running") && (
                <button className="text-rose-600" onClick={() => cancel(j.id)}>
                  Cancel
                </button>
              )}
              {j.output && (
                <button className="text-blue-700" onClick={() => navigator.clipboard.writeText(j.output)}>
                  Copy answer
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
