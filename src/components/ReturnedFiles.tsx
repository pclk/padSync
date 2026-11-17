"use client";

import { useEffect, useMemo, useState } from "react";
import { kb } from "@/lib/context";
import { parseReturnedNotebook, type ReturnedFile } from "@/lib/roundtrip";
import { applyNotebookChanges } from "@/lib/store";
import type { SectionEntity } from "@/lib/types";

// Files the agent wrote to out/: download any of them, and review out/notebook.json section by
// section before applying it. Nothing changes in the notebook until "Apply".

export function ReturnedFiles({ jobId, notebookId, sections, count }: { jobId: string; notebookId: string; sections: SectionEntity[]; count: number }) {
  const [files, setFiles] = useState<ReturnedFile[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || files) return;
    fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { job: { resultFiles: ReturnedFile[] } }) => setFiles(d.job.resultFiles))
      .catch((e) => setError((e as Error).message));
  }, [open, files, jobId]);

  return (
    <div className="mt-2 border-t border-slate-100 pt-2 text-xs">
      <button className="font-medium text-blue-700" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {count} returned file{count === 1 ? "" : "s"}
      </button>
      {error && <p className="text-rose-700">{error}</p>}
      {open && files && (
        <div className="mt-1 space-y-2">
          <ul>
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2">
                <span className="font-mono text-slate-700">{f.path}</span>
                <span className="text-slate-400">{kb((f.text?.length ?? 0) + ((f.base64?.length ?? 0) * 3) / 4)}</span>
                <button className="ml-auto text-blue-700" onClick={() => download(f)}>
                  Download
                </button>
              </li>
            ))}
          </ul>
          {files.some((f) => f.path === "notebook.json") && <ReviewChanges notebookId={notebookId} sections={sections} files={files} />}
        </div>
      )}
    </div>
  );
}

function download(f: ReturnedFile) {
  const body = f.base64 != null ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : (f.text ?? "");
  const url = URL.createObjectURL(new Blob([body], { type: f.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.path.replace(/\//g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReviewChanges({ notebookId, sections, files }: { notebookId: string; sections: SectionEntity[]; files: ReturnedFile[] }) {
  // Parsed once per opening: the live sections keep changing as you apply, and a re-parse would
  // then show already-applied changes as gone.
  const [parsed] = useState(() => parseReturnedNotebook(files.find((f) => f.path === "notebook.json")!.text ?? "", sections, files));
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(parsed.changes.map((_, i) => i)));
  const [applied, setApplied] = useState<string | null>(null);
  const picked = useMemo(() => parsed.changes.filter((_, i) => ticked.has(i)), [parsed, ticked]);

  if (applied) return <p className="text-emerald-700">{applied}</p>;
  return (
    <div className="rounded-lg border border-slate-200 p-2" data-testid="review-changes">
      <div className="mb-1 font-medium text-slate-700">Review changes from notebook.json</div>
      {parsed.problems.map((p) => (
        <p key={p} className="text-amber-700">
          {p}
        </p>
      ))}
      {!parsed.changes.length && <p className="text-slate-500">No changes compared with the notebook as it is now.</p>}
      <ul className="space-y-0.5">
        {parsed.changes.map((c, i) => (
          <li key={i}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={ticked.has(i)}
                onChange={(e) => {
                  const next = new Set(ticked);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  setTicked(next);
                }}
              />
              <span>
                {c.kind === "update" ? (
                  <>
                    <span className="text-slate-400">{c.index + 1}.</span> {c.title}: <span className="text-slate-500">{c.fields.join(", ")}</span>
                  </>
                ) : (
                  <>
                    <span className="rounded bg-emerald-50 px-1 text-emerald-700">new</span> {c.title}
                  </>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {parsed.changes.length > 0 && (
        <button
          className="mt-2 rounded-lg bg-blue-600 px-3 py-1 font-medium text-white disabled:opacity-40"
          disabled={!picked.length}
          onClick={async () => {
            const n = await applyNotebookChanges(notebookId, picked);
            setApplied(`Applied ${n} change${n === 1 ? "" : "s"}.`);
          }}
        >
          Apply {picked.length} change{picked.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
