"use client";
import PdfImport from "./PdfImport";
import { Icon } from "./Icons";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { DEFAULT_CONFIG, PRESETS, chatPrompt, pickResult, reviewPayload, selectSections, stage, type ImportConfig, type JobStatus, type ReturnedFile, type Stage } from "@/lib/ai-import";
import { blobToBase64 } from "@/lib/ask-bundle";
import { ACCEPT, checkLimits, formatBytes, move, needsCode } from "@/lib/attachments";
import { useStoredState } from "@/lib/hooks";
import { addFiles, clearAttachments, getDraft, listAttachments, removeAttachment, reorderAttachments, setDraft, type StoredAttachment } from "@/lib/import-drafts";
import { abortSend, getSendState, isSending, setCurrentJob, startSend, subscribeSend, type SendProgress } from "@/lib/import-send";
import { openNotebookNative } from "@/lib/native";
import { GOALS } from "@/lib/payload";
import { listNotebooks } from "@/lib/store";
import { applyImport } from "@/lib/import-application";
import PersistentPdfAttachments from "./PersistentPdfAttachments";
import { lectureSources } from "@/lib/lecture-sources";
import { associatePersistentPdf } from "@/lib/persistent-attachments";
import type { LectureSource } from "@/lib/types";
import type { ResolvedPdf } from "@/lib/persistent-attachments";
import { StudyBlock } from "./StudyBlocks";
import { downloadFile } from "@/lib/download";
import { highlight, renderMarkdown } from "@/lib/markdown";
import { SPACE_PX, type Block } from "@/lib/types";

// AI import: one page for the whole flow. Attach lecture notes → choose what to make → send it
// to the Mac bridge (or copy the prompt into a chat) → review the JSON → import. Every step stays
// usable; the current one is highlighted. Attachments and the JSON under review are kept in
// IndexedDB, and the running job's id in localStorage, so leaving the page loses nothing.

const MODELS: Record<ImportConfig["agent"], [string, string][]> = {
  claude: [["", "Default model"], ["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]],
  codex: [["", "Default model"], ["gpt-6.1-sol", "GPT-6.1 Sol"], ["gpt-6.1-terra", "GPT-6.1 Terra"], ["gpt-6-astra", "GPT-6 Astra"], ["gpt-6-sol", "GPT-6 Sol"], ["gpt-6-luna", "GPT-6 Luna"]],
};
const EFFORTS: Record<ImportConfig["agent"], string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh", "max", "ultra"] };
const BRIDGE_ONLINE_MS = 30_000;
const KIND_ICON: Record<StoredAttachment["kind"], string> = { pdf: "PDF", image: "IMG", text: "TXT", slides: "PPT", document: "DOC" };

interface Job {
  id: string;
  status: JobStatus;
  output: string;
  error: string | null;
  createdAt: string;
  resultFiles?: ReturnedFile[];
}

interface Status {
  authed: boolean;
  db: boolean;
  bridgeSeenAt: string | null;
}

function initialConfig(): ImportConfig {
  // The old AI prompt page kept its request here; carry it over once.
  try {
    const old = localStorage.getItem("padsync.promptRequest");
    if (old) return { ...DEFAULT_CONFIG, request: JSON.parse(old) as string };
  } catch {}
  return DEFAULT_CONFIG;
}

export default function AiImportView() {
  const router = useRouter();
  const initialNotebook = useSearchParams().get("notebookId") ?? "";
  const attachments = useLiveQuery(listAttachments, [], undefined);
  const list = useMemo(() => attachments ?? [], [attachments]);
  const [storedConfig, setStoredConfig] = useStoredState<ImportConfig>("padsync.import.config", initialConfig());
  const savedNotebooks = useLiveQuery(listNotebooks, [], []);
  const [pdfNotebookId, setPdfNotebookId] = useState(initialNotebook || "library");
  const [persistentPdfs, setPersistentPdfs] = useState<ResolvedPdf[]>([]);
  const sendAttachments = [...list.map((a) => ({ meta: a, blob: a.blob })), ...persistentPdfs];
  const config: ImportConfig = { ...DEFAULT_CONFIG, ...storedConfig };
  const setConfig = (patch: Partial<ImportConfig>) => setStoredConfig({ ...config, ...patch });
  // The send and the current job id live outside React (src/lib/import-send.ts): an upload keeps
  // going if you leave the page, and its progress is back when you return.
  const sendState = useSyncExternalStore(subscribeSend, getSendState, getSendState);
  const { jobId, progress, error: sendError } = sendState;
  const setJobId = setCurrentJob;
  const [jobState, setJob] = useState<Job | null>(null);
  const job = jobState && jobState.id === jobId ? jobState : null;
  const [status, setStatus] = useState<Status | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attachErrors, setAttachErrors] = useState<string[]>([]);

  // The JSON under review, from whichever source; restored from the draft store.
  const [raw, setRawState] = useState("");
  const [reviewSources, setReviewSources] = useState<LectureSource[]>([]);
  const [rawFrom, setRawFrom] = useState("");
  const [returned, setReturned] = useState<ReturnedFile[]>([]);
  const [imported, setImported] = useState<{ id: string; title: string } | null>(null);
  const draftLoaded = useRef<Promise<void> | null>(null);

  useEffect(() => {
    draftLoaded.current = Promise.all([getDraft<string>("raw"), getDraft<string>("rawFrom"), getDraft<ReturnedFile[]>("returned"), getDraft<LectureSource[]>("reviewSources")]).then(([r, from, files, sources]) => {
      setRawState(r ?? "");
      setRawFrom(from ?? "");
      setReturned(files ?? []);
      setReviewSources(sources ?? []);
    });
  }, []);

  // Saved shortly after the last change: typing into a multi-MB JSON shouldn't rewrite it per key.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setRaw = useCallback((text: string, from: string, files: ReturnedFile[] = [], now = false): Promise<void> => {
    if (!from.includes("bridge")) { setReviewSources([]); void setDraft("reviewSources", []); }
    setRawState(text);
    setRawFrom(from);
    setReturned(files);
    setImported(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const save = () => Promise.all([setDraft("raw", text), setDraft("rawFrom", from), setDraft("returned", files.length ? files : null)]).then(() => {});
    if (now) return save();
    saveTimer.current = setTimeout(() => void save(), 300);
    return Promise.resolve();
  }, [setImported, setReviewSources]);

  // Server status (signed in, bridge seen) every 10 s while the page is visible.
  useEffect(() => {
    const load = () =>
      fetch("/api/status")
        .then((r) => r.json())
        .then((s: Status) => {
          setStatus(s);
          setNow(Date.now());
        })
        .catch(() => setStatus(null));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 10_000);
    return () => clearInterval(t);
  }, []);

  // A finished job's result goes into review once (not again after edits or a reload). Waits for
  // the draft to load, so the restored draft can't overwrite a newer result.
  const consumeResult = useCallback(
    async (j: Job) => {
      await draftLoaded.current;
      if ((await getDraft<string>("loadedJob")) === j.id) return;
      const picked = pickResult(j);
      // Saved before marking the job consumed: a reload in between must not lose the result.
      if (picked) {
        const sources = await getDraft<LectureSource[]>(`jobSources:${j.id}`) ?? [];
        setReviewSources(sources);
        await setDraft("reviewSources", sources);
        await setRaw(picked.text, `${picked.from} from the bridge`, j.resultFiles ?? [], true);
      }
      await setDraft("loadedJob", j.id);
    },
    [setRaw, setReviewSources],
  );

  // Follow the current job; stop polling once it is finished.
  const active = !job || job.status === "uploading" || job.status === "queued" || job.status === "running";
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    const load = () =>
      fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
        .then((r) => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { job: Job } | null) => {
          if (!live) return;
          if (!d) return setJobId(null); // deleted or another server: forget it
          setJob(d.job);
          setNow(Date.now());
          if (d.job.status === "done") void consumeResult(d.job);
        })
        .catch(() => {});
    void load();
    if (!active) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [jobId, active, setJobId, consumeResult]);

  const limitErrors = checkLimits(sendAttachments.map((a) => a.meta));
  const bridgeOnline = !!status?.bridgeSeenAt && now - new Date(status.bridgeSeenAt).getTime() < BRIDGE_ONLINE_MS;
  const sending = !!progress;
  const current: Stage = stage({ attachments: sendAttachments.length, sending, job, raw, imported: !!imported });
  const officeNeedsCode = needsCode(list) && config.agent === "claude" && !config.allowCode;

  const onFiles = async (files: FileList | File[] | null | undefined) => {
    if (!files?.length) return;
    setAttachErrors(await addFiles([...files]));
  };

  const send = async () => {
    if (isSending()) return;
    // An upload interrupted earlier (tab closed) is abandoned for this new one.
    if (jobId && job?.status === "uploading") await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => null);
    await startSend({ config, attachments: sendAttachments.map((a) => ({ meta: a.meta, base64: () => blobToBase64(a.blob) })) });
  };

  const cancel = async () => {
    abortSend();
    if (jobId) await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => null);
    setJob((j) => (j ? { ...j, status: "cancelled" } : j));
  };

  const startOver = async () => {
    if (!confirm("Remove the attachments and the JSON under review? A running AI job is cancelled.")) return;
    abortSend();
    // Don't leave the agent working on a job the page has forgotten.
    if (jobId && job && ["uploading", "queued", "running"].includes(job.status)) await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => null);
    await clearAttachments();
    setPersistentPdfs([]);
    setPdfNotebookId("");
    setRaw("", "");
    setJobId(null);
    setAttachErrors([]);
  };

  return (
    <main className="mx-auto max-w-4xl px-4 pb-16 pt-5 sm:px-8 sm:pt-8">
      <Link href="/" className="btn btn-ghost -ml-2 px-2"><Icon name="back" className="text-lg" />Library</Link>
      <div className="mb-8 mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight text-slate-900"><Icon name="sparkles" className="text-brand-600" />AI import</h1>
          <p className="mt-1 text-sm text-slate-500">Lecture notes in, a notebook to study and write on out.</p>
        </div>
        <button className="btn btn-danger btn-sm ml-auto" onClick={startOver}>
          Start over
        </button>
      </div>

      <div className="mb-4"><PdfImport /></div>
      <div className="card mb-4 p-5 text-sm">
        <label className="mb-3 flex flex-wrap items-center gap-2 font-semibold text-slate-900">Saved lecture PDFs from <select className="field w-auto py-1.5 font-normal" aria-label="Saved PDF notebook" value={pdfNotebookId} onChange={(e) => { setPersistentPdfs([]); setPdfNotebookId(e.target.value); }}>
          <option value="library">Lecture library (for a new notebook)</option>
          {savedNotebooks.map((n) => <option key={n.id} value={n.id}>{n.data.title}</option>)}
        </select></label>
        {pdfNotebookId && <PersistentPdfAttachments key={pdfNotebookId} notebookId={pdfNotebookId} onChange={setPersistentPdfs} />}
      </div>
      <Step n={1} title="Lecture notes" active={current === "attach"} done={sendAttachments.length > 0}>
        <p className="mb-2 text-xs text-slate-500">Files here are local drafts. Upload PDFs in Saved lecture PDFs above to reopen them on other devices.</p>
        <Attachments list={list} onFiles={onFiles} errors={[...attachErrors, ...limitErrors]} />
      </Step>

      <Step n={2} title="What to make" active={current === "configure"} done={false}>
        <Configure config={config} setConfig={setConfig} officeNeedsCode={officeNeedsCode} />
      </Step>

      <Step n={3} title="Generate" active={current === "sending" || current === "waiting"} done={job?.status === "done"}>
        <Generate
          status={status}
          bridgeOnline={bridgeOnline}
          canSend={sendAttachments.length > 0 && !limitErrors.length && !sending && !(job && (job.status === "queued" || job.status === "running"))}
          send={send}
          cancel={cancel}
          progress={progress}
          job={job}
          sendError={sendError}
          prompt={() => chatPrompt(config, sendAttachments.map((a) => a.meta))}
          resultMissing={!!job && job.status === "done" && !pickResult(job)}
          reload={
            job?.status === "done" && pickResult(job)
              ? async () => {
                  const sources = await getDraft<LectureSource[]>(`jobSources:${job.id}`) ?? [];
                  setReviewSources(sources);
                  await setDraft("reviewSources", sources);
                  const r = pickResult(job)!;
                  setRaw(r.text, `${r.from} from the bridge`, job.resultFiles ?? []);
                }
              : null
          }
        />
      </Step>

      <Step n={4} title="Review & import" active={current === "review" || current === "imported"} done={!!imported}>
        {persistentPdfs.length > 0 && <button className="mb-3 rounded-lg border px-3 py-2 text-sm" onClick={() => {
          const sources = lectureSources(persistentPdfs.map(f => f.meta));
          setReviewSources(sources); void setDraft("reviewSources", sources);
        }}>Use selected PDF references for this preview (including pasted JSON)</button>}
        {reviewSources.length > 0 && <p className="mb-2 text-xs text-slate-600">Sources: {reviewSources.map(s => `${s.name ?? "PDF"}${s.pages?.length ? ` (pages ${s.pages.join(", ")})` : " (all pages)"}`).join("; ")}</p>}
        <Review
          sources={reviewSources}
          initialDestination={initialNotebook}
          raw={raw}
          from={rawFrom}
          returned={returned}
          setRaw={setRaw}
          jobId={jobId}
          imported={imported}
          onImported={(id, title) => setImported({ id, title })}
          open={(id) => { if (!openNotebookNative(id)) router.push(`/notebook?id=${id}`); }}
        />
      </Step>
    </main>
  );
}

function Step({ n, title, active, done, children }: { n: number; title: string; active: boolean; done: boolean; children: ReactNode }) {
  return (
    <section className={`mb-4 rounded-2xl border bg-white p-5 shadow-card ${active ? "border-brand-300 ring-4 ring-brand-50" : "border-slate-200"}`} data-step={n} data-active={active ? "1" : undefined}>
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-slate-900">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${done ? "bg-emerald-600 text-on-accent" : active ? "bg-brand-600 text-on-accent" : "bg-slate-200 text-slate-600"}`}>{done ? "✓" : n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Attachments({ list, onFiles, errors }: { list: StoredAttachment[]; onFiles: (f: FileList | File[]) => void; errors: string[] }) {
  const [over, setOver] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const total = list.reduce((n, a) => n + a.size, 0);
  const reorder = (from: number, to: number) => void reorderAttachments(move(list, from, to).map((a) => a.id));

  return (
    <div>
      <div
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm ${over ? "border-brand-500 bg-brand-50" : "border-slate-300 bg-slate-50"}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
        }}
        data-testid="dropzone"
      >
        <p className="text-slate-600">Drop lecture notes here: PDF, slides (.pptx), images, Markdown or text.</p>
        <button className="btn btn-secondary mt-3" onClick={() => input.current?.click()}>
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onFiles(e.target.files);
            e.target.value = ""; // picking the same file again still fires
          }}
        />
      </div>
      {list.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {list.map((a, i) => (
            <li
              key={a.id}
              draggable
              onDragStart={(e) => {
                setDragId(a.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragId) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.stopPropagation();
                reorder(list.findIndex((x) => x.id === dragId), i);
                setDragId(null);
              }}
              onDragEnd={() => setDragId(null)}
              className={`flex items-center gap-3 px-3 py-2 text-sm ${dragId === a.id ? "opacity-40" : ""}`}
            >
              <span className="cursor-grab select-none text-slate-300" aria-hidden>⋮⋮</span>
              <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{KIND_ICON[a.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-slate-800" title={a.name}>{a.name}</span>
              <span className="text-xs text-slate-400">{formatBytes(a.size)}</span>
              <button className="px-1 text-slate-500 disabled:opacity-20" disabled={i === 0} onClick={() => reorder(i, i - 1)} aria-label={`Move ${a.name} up`}>↑</button>
              <button className="px-1 text-slate-500 disabled:opacity-20" disabled={i === list.length - 1} onClick={() => reorder(i, i + 1)} aria-label={`Move ${a.name} down`}>↓</button>
              <button className="px-1 text-rose-600" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.name}`}>✕</button>
            </li>
          ))}
          <li className="px-3 py-1.5 text-right text-xs text-slate-500">
            {list.length} file{list.length === 1 ? "" : "s"} · {formatBytes(total)} · sent in this order
          </li>
        </ul>
      )}
      {errors.map((e) => (
        <p key={e} className="mt-2 text-xs text-rose-700">{e}</p>
      ))}
    </div>
  );
}

function Configure({ config, setConfig, officeNeedsCode }: { config: ImportConfig; setConfig: (p: Partial<ImportConfig>) => void; officeNeedsCode: boolean }) {
  const toggle = (id: string) => setConfig({ goals: config.goals.includes(id) ? config.goals.filter((g) => g !== id) : [...config.goals, id] });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <span className="py-1 text-xs text-slate-500">Start from:</span>
        {PRESETS.map((p) => (
          <button key={p.label} onClick={() => setConfig({ goals: p.goals, request: p.request })} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700">
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
        {GOALS.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-slate-700">
            <input type="checkbox" checked={config.goals.includes(g.id)} onChange={() => toggle(g.id)} />
            {g.label}
          </label>
        ))}
      </div>
      <textarea
        className="h-24 w-full rounded-xl border border-slate-300 bg-white p-3 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-50"
        placeholder="Anything specific? e.g. Focus on slides 12–30; my exam is open-book; use the lecturer's notation."
        value={config.request}
        onChange={(e) => setConfig({ request: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" value={config.agent} onChange={(e) => setConfig({ agent: e.target.value as ImportConfig["agent"], model: undefined, effort: undefined })} aria-label="Agent">
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1" value={config.model ?? ""} onChange={(e) => setConfig({ model: e.target.value || undefined })} aria-label="Model">
          {MODELS[config.agent].map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select className="rounded-lg border border-slate-300 bg-white px-2 py-1" value={config.effort ?? ""} onChange={(e) => setConfig({ effort: e.target.value || undefined })} aria-label="Thinking effort">
          <option value="">Default effort</option>
          {EFFORTS[config.agent].map((v) => (
            <option key={v} value={v}>{v} effort</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-slate-600">
          <input type="checkbox" checked={!!config.webSearch} onChange={(e) => setConfig({ webSearch: e.target.checked })} /> web search
        </label>
        <label className="flex items-center gap-1 text-slate-600" title="Lets Claude run commands in its sandbox, e.g. to unpack slides or check the JSON.">
          <input type="checkbox" checked={!!config.allowCode} onChange={(e) => setConfig({ allowCode: e.target.checked })} /> allow running code
        </label>
      </div>
      {officeNeedsCode && <p className="text-xs text-amber-700">Claude can only read .pptx/.docx by running a command: tick “allow running code”, or export the files as PDF.</p>}
    </div>
  );
}

function Generate(p: {
  status: Status | null;
  bridgeOnline: boolean;
  canSend: boolean;
  send: () => void;
  cancel: () => void;
  progress: SendProgress | null;
  job: Job | null;
  sendError: string | null;
  prompt: () => string;
  resultMissing: boolean;
  /** Puts the finished job's result back into review (after Clear or edits). */
  reload: (() => void) | null;
}) {
  const [copied, setCopied] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const signedIn = !!p.status?.authed;
  const j = p.job;
  const running = !!p.progress || (j && (j.status === "uploading" || j.status === "queued" || j.status === "running"));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.prompt());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setShowPrompt(true);
    }
  };
  const download = () => downloadFile("padsync-prompt.md", p.prompt(), "text/markdown");

  return (
    <div className="grid gap-4 text-sm md:grid-cols-[3fr_2fr]">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="font-medium text-slate-800">Send to your Mac</span>
          <span className={`flex items-center gap-1.5 text-xs ${p.bridgeOnline ? "text-emerald-700" : "text-slate-400"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${p.bridgeOnline ? "bg-emerald-500" : "bg-slate-300"}`} />
            {!signedIn ? "sign in to use the bridge" : p.bridgeOnline ? "bridge online" : "bridge offline (the job waits for it)"}
          </span>
        </div>
        {!signedIn ? (
          <p className="text-slate-500">
            Sign in on <Link href="/settings" className="text-brand-700 underline">Settings</Link> and run the Mac bridge to send files straight to Claude Code or Codex. Or use the prompt on the right.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" disabled={!p.canSend} onClick={p.send}>
              {j?.status === "done" || j?.status === "error" || j?.status === "cancelled" ? "Send again" : "Send"}
            </button>
            {running && (
              <button className="btn btn-secondary text-rose-700" onClick={p.cancel}>
                Cancel
              </button>
            )}
          </div>
        )}
        <Progress progress={p.progress} job={j} bridgeOnline={p.bridgeOnline} />
        {p.sendError && <p className="mt-2 text-xs text-rose-700">{p.sendError}</p>}
        {j?.status === "error" && <p className="mt-2 text-xs text-rose-700">The AI run failed: {j.error ?? "unknown error"}. Send again, or paste a reply below.</p>}
        {p.resultMissing && <p className="mt-2 text-xs text-amber-700">The AI finished but didn&apos;t return padsync.json. Its answer is above; send again or paste JSON below.</p>}
        {p.reload && (
          <button className="mt-2 text-xs text-brand-700 underline" onClick={p.reload}>
            Load this result into review again
          </button>
        )}
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="mb-1 font-medium text-slate-800">No bridge? Use any chat</div>
        <p className="mb-2 text-xs text-slate-600">Copy the prompt into Claude or ChatGPT, attach the same lecture files there, then paste the reply in step 4.</p>
        <div className="flex gap-2">
          <button onClick={copy} className="btn btn-primary btn-sm">{copied ? "Copied" : "Copy prompt"}</button>
          <button onClick={download} className="btn btn-secondary btn-sm">Download</button>
          <button onClick={() => setShowPrompt(!showPrompt)} className="text-xs text-slate-500 underline">{showPrompt ? "Hide" : "Show"}</button>
        </div>
      </div>
      {showPrompt && <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100 md:col-span-2">{p.prompt()}</pre>}
    </div>
  );
}

function Progress({ progress, job, bridgeOnline }: { progress: SendProgress | null; job: Job | null; bridgeOnline: boolean }) {
  let label: string | null = null;
  let pct: number | null = null;
  if (progress) {
    if (progress.phase === "creating") label = "Creating the job…";
    else {
      pct = progress.total ? progress.sent / progress.total : 0;
      label = `Uploading ${formatBytes(Math.round((progress.sent * 3) / 4))} of ${formatBytes(Math.round((progress.total * 3) / 4))}`;
    }
  } else if (job?.status === "uploading") label = "The upload was interrupted (page closed or reloaded). Send again to retry.";
  else if (job?.status === "queued") label = bridgeOnline ? "Waiting for the bridge to pick it up… (if this lasts, update the bridge: older versions can't run imports)" : "Queued: it starts when the bridge on your Mac is running.";
  else if (job?.status === "running") label = "The AI is reading your notes and writing the notebook…";
  else if (job?.status === "done") label = "Done.";
  else if (job?.status === "cancelled") label = "Cancelled.";
  if (!label) return null;
  return (
    <div className="mt-3" data-testid="progress">
      <div className="text-xs text-slate-600">{label}</div>
      {pct !== null && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
      {job?.status === "running" && <div className="mt-1 h-1.5 animate-pulse rounded-full bg-amber-300" />}
      {job?.output && (job.status === "running" || job.status === "done") && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{job.output.length > 1500 ? "…" + job.output.slice(-1500) : job.output}</pre>
      )}
    </div>
  );
}

function Review(p: {
  sources: LectureSource[];
  initialDestination: string;
  raw: string;
  from: string;
  returned: ReturnedFile[];
  setRaw: (text: string, from: string, files?: ReturnedFile[]) => void;
  jobId: string | null;
  imported: { id: string; title: string } | null;
  onImported: (id: string, title: string) => void;
  open: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notebooks = useLiveQuery(listNotebooks, [], []);
  const [destination, setDestination] = useState(p.initialDestination || "new");
  // Parsing a large payload on every keystroke would stall typing; React parses the latest text
  // when it has time, and the import uses that same parsed result.
  const deferredRaw = useDeferredValue(p.raw);
  const result = useMemo(() => (deferredRaw.trim() ? reviewPayload(deferredRaw, p.returned) : null), [deferredRaw, p.returned]);
  const importing = useRef(false);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  // A new result starts with every section ticked.
  const [seenRaw, setSeenRaw] = useState(p.raw);
  if (seenRaw !== p.raw) {
    setSeenRaw(p.raw);
    setUnticked(new Set());

    setError(null);
  }
  const validIdx = result?.sections.filter((s) => s.ok).map((s) => s.index) ?? [];
  const ticked = new Set(validIdx.filter((i) => !unticked.has(i)));
  const total = result?.sections.length ?? 0;
  const file = useRef<HTMLInputElement>(null);

  const onFile = async (f: File | undefined) => {
    if (f) p.setRaw(await f.text(), f.name);
  };

  const doImport = async () => {
    const payload = result && deferredRaw === p.raw ? selectSections(result, ticked) : null;
    // A ref, not just state: two taps in one frame would both see busy === false.
    if (!payload || importing.current) return;
    importing.current = true;
    setBusy(true);
    setError(null);
    try {
      const applied = await applyImport({ raw: p.raw, returned: p.returned, selected: ticked,
        destination: destination === "new" ? { kind: "new" } : { kind: "append", notebookId: destination },
        accepted: true, sources: p.sources, ...(p.jobId && p.from.includes("bridge") ? { jobId: p.jobId } : {}) });
      if (!applied) return;
      p.onImported(applied.notebookId, applied.title);
      try { await Promise.all(p.sources.map(s => associatePersistentPdf(s.attachmentId, applied.notebookId))); }
      catch { setError("Sections were saved. Some PDF associations are unavailable; the notebook link below opens your saved work. Original filename and page references are retained."); return; }
      if (applied.duplicate) setError("This result was already applied. Open the notebook using the link below.");
      else p.open(applied.notebookId);
    } catch (e) {
      setError(`Couldn't create the notebook: ${(e as Error).message}`);
    } finally {
      importing.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="text-sm">
      {!p.raw.trim() || editing ? (
        <div>
          <textarea
            className="h-56 w-full rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-50"
            value={p.raw}
            onChange={(e) => p.setRaw(e.target.value, p.from || "pasted text", p.returned)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
            placeholder={'Paste the AI\'s reply here (code fences and text around it are fine), or drop a .json file.\n\n{"schemaVersion": 2, "title": "…", "sections": [ … ]}'}
          />
          <div className="mt-2 flex items-center gap-3">
            <button className="btn btn-secondary" onClick={() => file.current?.click()}>
              Open .json file
            </button>
            <input ref={file} type="file" accept=".json,application/json,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            {editing && (
              <button className="text-brand-700" onClick={() => setEditing(false)}>
                Done editing
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-3 text-xs text-slate-500">
          <span>From {p.from || "pasted text"}</span>
          <button className="text-brand-700" onClick={() => setEditing(true)}>Edit JSON</button>
          <button className="text-slate-500 hover:text-rose-600" onClick={() => p.setRaw("", "")}>Clear</button>
        </div>
      )}

      {result && (
        <div className="mt-3" data-testid="review">
          {result.payload && (
            <div className="mb-2">
              <div className="text-base font-semibold text-slate-900">{result.payload.title}</div>
              {result.payload.description && <div className="text-slate-600">{result.payload.description}</div>}
              {result.fromVersion === 1 && <div className="text-xs text-slate-500">Older format (version 1): converted.</div>}
            </div>
          )}
          {result.sections.length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {result.sections.map((s) => (
                <li key={s.index} className="px-3 py-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      disabled={!s.ok}
                      checked={s.ok && ticked.has(s.index)}
                      onChange={(e) => {
                        const next = new Set(unticked);
                        if (e.target.checked) next.delete(s.index);
                        else next.add(s.index);
                        setUnticked(next);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-slate-400">{s.index + 1}.</span> <span className={s.ok ? "text-slate-800" : "text-rose-700"}>{s.title}</span>
                      {s.section?.kind && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{s.section.kind}</span>}
                      {s.section && <span className="ml-2 text-xs text-slate-400">{blockSummary(s.section.blocks)}</span>}
                      {s.errors.map((e) => (
                        <span key={e} className="block text-xs text-rose-700">{e}</span>
                      ))}
                    </span>
                  </label>
                  {s.section && <details className="mt-2 rounded bg-white p-3" open><summary className="cursor-pointer text-xs text-brand-700">Section preview</summary><div className="max-h-96 overflow-auto">{s.section.blocks.map((block, i) => <ImportBlockPreview key={i} block={block} />)}</div></details>}
                </li>
              ))}
            </ul>
          )}
          {!result.sections.length && result.errors.map((e) => <p key={e} className="text-xs text-rose-700">{e}</p>)}
          {result.warnings.length > 0 && (
            // Open by itself when content was left out or a newer format was read, not for cosmetic fixes.
            <details className="mt-2 text-xs text-amber-800" open={result.warnings.some((w) => /newer padSync|left out|unknown block type/.test(w))}>
              <summary className="cursor-pointer">{result.warnings.length} note{result.warnings.length === 1 ? "" : "s"} (fixed or ignored automatically)</summary>
              <ul className="mt-1 list-disc pl-5">
                {result.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          <label className="mt-3 block text-slate-700">
            Apply selected sections to
            <select aria-label="Import destination" className="ml-2 rounded border p-2" value={destination} onChange={(e) => setDestination(e.target.value)} disabled={busy}>
              <option value="new">New notebook</option>
              {notebooks.map((n) => <option key={n.id} value={n.id}>Append to {n.data.title}</option>)}
            </select>
          </label>
          <button className="mt-2 text-slate-500" disabled={busy} onClick={() => p.setRaw("", "")}>Cancel preview</button>
          {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
          {p.imported ? (
            <p className="mt-3 text-emerald-700">
              Imported <Link className="underline" href={`/notebook?id=${p.imported.id}`} onClick={(e) => { if (p.imported && openNotebookNative(p.imported.id)) e.preventDefault(); }}>{p.imported.title}</Link>.
            </p>
          ) : (
            result.ok && (
              <button className="mt-3 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-30" disabled={!ticked.size || busy || deferredRaw !== p.raw} onClick={() => void doImport()}>
                {busy ? "Importing…" : ticked.size === total ? `Import ${total} section${total === 1 ? "" : "s"}` : `Import ${ticked.size} of ${total} sections`}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function blockSummary(blocks: { type: string }[]) {
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.type !== "space" && b.type !== "divider") counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${n} ${t}` : t)).join(" · ");
}

function ImportBlockPreview({ block }: { block: Block }) {
  switch (block.type) {
    case "markdown": return <div className="prose-pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />;
    case "code": return <pre className="hljs overflow-auto rounded p-3"><code dangerouslySetInnerHTML={{ __html: highlight(block.code, block.language) }} /></pre>;
    case "image": return <figure>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={block.src} alt={block.alt ?? ""} style={{ width: `${(block.width ?? 0.6) * 100}%` }} />{block.caption && <figcaption>{block.caption}</figcaption>}</figure>;
    case "space": return <div className="study-lines" style={{ height: typeof block.size === "number" ? block.size : SPACE_PX[block.size] }} />;
    case "divider": return <hr className="my-4" />;
    default: return <StudyBlock block={block} />;
  }
}
