"use client";
import { useEffect, useState } from "react";
import type { SectionEntity } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { ReturnedFiles } from "./ReturnedFiles";
type Agent = "claude" | "codex";
interface JobOptions {
  model?: string;
  effort?: string;
  webSearch?: boolean;
}
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

async function fetchJobs(sectionId: string) {
  const res = await fetch(
    `/api/jobs?sectionId=${encodeURIComponent(sectionId)}`,
  ).catch(() => null);
  return res?.ok
    ? ((await res.json()) as { jobs: Job[]; bridgeSeenAt: string | null })
    : null;
}

function StatusChip({ status }: { status: Job["status"] }) {
  const style: Record<Job["status"], string> = {
    queued: "bg-slate-100 text-slate-600",
    running: "bg-amber-100 text-amber-800",
    done: "bg-emerald-100 text-emerald-800",
    error: "bg-rose-100 text-rose-800",
    cancelled: "bg-slate-100 text-slate-400",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 ${style[status]}`}>{status}</span>
  );
}

export function EarlierQuestions({
  sectionId,
  notebookId,
  sections,
}: {
  sectionId: string;
  notebookId: string;
  sections: SectionEntity[];
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let live = true;
    void fetchJobs(sectionId).then((data) => {
      if (live) setJobs(data?.jobs ?? []);
    });
    return () => {
      live = false;
    };
  }, [sectionId]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copy = async (j: Job) => {
    try {
      await navigator.clipboard.writeText(j.output);
      setCopiedId(j.id);
    } catch {
      setCopiedId(null);
    }
  };
  return (
    <details>
      <summary className="cursor-pointer text-slate-600">
        Earlier questions · Ask AI history
      </summary>{" "}
      <ul className="mt-3 space-y-3">
        {jobs.map((j) => (
          <li
            key={j.id}
            className="rounded-lg border border-slate-200 bg-white p-3"
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700">
                {j.agent === "claude" ? "Claude Code" : "Codex"}
              </span>
              {(j.options?.model || j.options?.effort) && (
                <span>
                  {[j.options.model, j.options.effort]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
              <StatusChip status={j.status} />
              <span className="ml-auto">
                {new Date(j.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="mb-2 text-slate-600">{j.question}</p>
            {j.output && (
              <div
                className="prose-pad border-t border-slate-100 pt-2"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(j.output) }}
              />
            )}

            {j.error && <p className="mt-1 text-xs text-rose-700">{j.error}</p>}
            {j.status === "done" && !!j.resultFiles?.length && (
              <ReturnedFiles
                jobId={j.id}
                notebookId={notebookId}
                sections={sections}
                count={j.resultFiles.length}
              />
            )}
            <div className="mt-2 flex gap-2 text-xs">
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
    </details>
  );
}
