"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { copySectionImage, sectionSource, sectionStats } from "@/lib/export";
import { renderMarkdown } from "@/lib/markdown";
import { useShowCopyButtons } from "@/lib/settings";
import { insertSectionAfter, logEvent, setDeleted, swapSectionOrder } from "@/lib/store";
import type { Selection } from "@/ink/controller";
import type { PresenceEntity, SectionEntity } from "@/lib/types";
import { EarlierQuestions } from "./AskPanel";
import { ChatPanel } from "./chat/ChatPanel";
import type { PanelMode } from "@/lib/chat-types";

interface Props {
  mode?: PanelMode;
  width?: number;
  notebookId: string;
  notebookTitle: string;
  selection: Selection | null;
  sections: SectionEntity[];
  current: SectionEntity | null;
  sectionEl: (id: string) => HTMLElement | undefined;
  follow: boolean;
  setFollow: (v: boolean) => void;
  ipad: PresenceEntity | null;
  onJump: (id: string) => void;
}

function fmt(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function SidePanel(p: Props) {
  const { current } = p;
  const [tab, setTab] = useState("chat");
  const [toast, setToast] = useState<string | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [showCopy] = useShowCopyButtons();
  const stats = useLiveQuery(() => (current ? sectionStats(current.id) : undefined), [current?.id, current?.hlc]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  const flash = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  };

  const copyImage = () => {
    const el = current && p.sectionEl(current.id);
    if (!current || !el) return;
    copySectionImage(current, el).then(
      () => {
        flash("Image copied: paste into Claude or ChatGPT");
        void logEvent(p.notebookId, current.id, "copy_image");
      },
      (e) => flash(`Copy failed: ${(e as Error).message}`),
    );
  };

  const copySource = async () => {
    if (!current) return;
    await navigator.clipboard.writeText(await sectionSource(current));
    flash("Question text copied");
    void logEvent(p.notebookId, current.id, "copy_source");
  };

  const idx = current ? p.sections.findIndex((s) => s.id === current.id) : -1;
  const ipadHere = p.ipad && p.ipad.notebookId === p.notebookId;

  return (
    <aside style={{ width: p.width ?? 360 }} className="side-panel fixed bottom-0 right-0 top-14 z-30 flex flex-col overflow-hidden border-l border-slate-200 bg-slate-50 text-sm transition-[width] duration-250 motion-reduce:transition-none">
      <div className="flex shrink-0 gap-2 border-b p-2" role="tablist" aria-label="Side panel">
        {["chat", "section"].map((t) => <button key={t} role="tab" aria-selected={tab === t} className="rounded-lg px-3 py-1 capitalize aria-selected:bg-white" onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className={tab === "chat" ? "flex min-h-0 flex-1" : "hidden"}><ChatPanel {...p} mode={p.mode ?? "drawing"} visible={tab === "chat"} /></div>
      <div className={tab === "section" ? "overflow-y-auto" : "hidden"}>
      <div className="border-b border-slate-200 p-4">
        <label className="flex items-center justify-between gap-2">
          <span className="font-medium text-slate-700">Follow iPad</span>
          <input type="checkbox" checked={p.follow} onChange={(e) => p.setFollow(e.target.checked)} className="h-4 w-4" />
        </label>
        <p className="mt-1 text-xs text-slate-500">
          {!p.ipad
            ? "No iPad seen yet."
            : ipadHere
              ? `iPad is on ${p.sections.find((s) => s.id === p.ipad!.data.sectionId)?.data.title ?? "this notebook"}`
              : "iPad is on another notebook."}
          {ipadHere && p.ipad && <> · <PresenceAge at={p.ipad.data.at} /></>}
        </p>
      </div>

      {current ? (
        <div className="border-b border-slate-200 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold text-slate-800">{current.data.title ?? `Section ${idx + 1}`}</h2>
            <span className="text-xs text-slate-400">
              {idx + 1} / {p.sections.length}
            </span>
          </div>
          {showCopy && (
            <div className="mb-4 grid grid-cols-2 gap-2" data-testid="copy-buttons">
              <button className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-700" onClick={copyImage}>
                Copy as image
              </button>
              <button className="rounded-lg border border-slate-300 bg-white px-3 py-2 hover:bg-slate-100" onClick={copySource}>
                Copy question text
              </button>
            </div>
          )}
          <EarlierQuestions key={current.id} sectionId={current.id} notebookId={p.notebookId} sections={p.sections} />

          {stats && (
            <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Stat label="strokes" value={String(stats.strokes)} />
              <Stat label="erased" value={String(stats.erased)} />
              <Stat label="pen time" value={fmt(stats.inkMs)} />
              <Stat label="first → last" value={fmt(stats.spanMs)} />
              <Stat label="visits" value={String(stats.focusEvents)} />
              <Stat label="limit" value={current.data.timeLimitMinutes ? `${current.data.timeLimitMinutes}m` : "—"} />
            </dl>
          )}

          {current.data.solution && (
            <div className="mt-4">
              <button className="text-xs font-medium text-blue-700" onClick={() => setShowSolution(!showSolution)}>
                {showSolution ? "Hide solution" : "Reveal solution"}
              </button>
              {showSolution && <div className="prose-pad mt-2 rounded-lg bg-white p-3 text-[14px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(current.data.solution) }} />}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-1 text-xs">
            <button className="rounded border bg-white px-2 py-1 disabled:opacity-40" disabled={idx <= 0} onClick={() => swapSectionOrder(current, p.sections[idx - 1])}>
              Move up
            </button>
            <button className="rounded border bg-white px-2 py-1 disabled:opacity-40" disabled={idx >= p.sections.length - 1} onClick={() => swapSectionOrder(current, p.sections[idx + 1])}>
              Move down
            </button>
            <button className="rounded border bg-white px-2 py-1" onClick={() => insertSectionAfter(p.notebookId, current, p.sections)}>
              Blank page after
            </button>
            <button
              className="rounded border bg-white px-2 py-1 text-rose-600 disabled:opacity-40"
              disabled={p.sections.length <= 1}
              onClick={() => confirm("Delete this section? (Its ink is kept in history.)") && setDeleted([current.id], true)}
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}

      <nav className="p-2">
        <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Outline</div>
        {p.sections.map((s, i) => (
          <button
            key={s.id}
            onClick={() => p.onJump(s.id)}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${s.id === current?.id ? "bg-white shadow-sm" : "hover:bg-white/60"}`}
          >
            <span className="w-6 text-right text-xs tabular-nums text-slate-400">{i + 1}</span>
            <span className="truncate text-slate-700">{s.data.title ?? (s.data.blocks.length ? "Untitled" : "Blank page")}</span>
            {p.ipad?.data.sectionId === s.id && <span className="ml-auto rounded bg-blue-100 px-1.5 text-[10px] text-blue-700">iPad</span>}
          </button>
        ))}
      </nav>

      {toast && <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-900 px-3 py-2 text-white shadow-lg">{toast}</div>}
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white px-2 py-2">
      <dd className="text-base font-semibold tabular-nums text-slate-800">{value}</dd>
      <dt className="text-[11px] text-slate-500">{label}</dt>
    </div>
  );
}

function PresenceAge({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return <>{fmt(Math.max(0, now - at))} ago</>;
}
