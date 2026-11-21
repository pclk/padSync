"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { copySectionImage, sectionSource, sectionStats } from "@/lib/export";
import { renderMarkdown } from "@/lib/markdown";
import { useShowCopyButtons } from "@/lib/settings";
import {
  insertSectionAfter,
  logEvent,
  setDeleted,
  swapSectionOrder,
} from "@/lib/store";
import type { Selection } from "@/ink/controller";
import type { PresenceEntity, SectionEntity } from "@/lib/types";
import { EarlierQuestions } from "./AskPanel";
import { ChatPanel } from "./chat/ChatPanel";
import { LecternPanel } from "./LecternPanel";
import { MaterialPanel } from "./MaterialPanel";
import type { PackPage } from "@/lib/pack";
import type { PanelMode } from "@/lib/chat-types";
import { PROMPT_EVENT } from "@/lib/prompts";

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
  /** Annotation packs: each section's page in its PDF's page map (lib/pack.ts). */
  packMap?: Map<string, PackPage>;
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
  const [play, setPlay] = useState<{ path: string; n: number } | null>(null);
  const [showCopy] = useShowCopyButtons();
  const stats = useLiveQuery(
    () => (current ? sectionStats(current.id) : undefined),
    [current?.id, current?.hlc],
  );

  // A prompt from the iPad's prompt menu goes to the chat, so show it.
  useEffect(() => {
    const show = () => setTab("chat");
    window.addEventListener(PROMPT_EVENT, show);
    return () => window.removeEventListener(PROMPT_EVENT, show);
  }, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
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
    <aside
      style={{ width: p.width ?? 360 }}
      className="side-panel fixed bottom-0 right-0 top-14 z-30 flex flex-col overflow-hidden border-l border-slate-200 bg-white text-sm transition-[width] duration-250 motion-reduce:transition-none"
    >
      <div
        className="flex shrink-0 items-center border-b border-slate-200 px-3 py-2"
        role="tablist"
        aria-label="Side panel"
      >
        {["chat", "section", "material", "lecture"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className="relative px-3 py-1.5 text-sm font-medium capitalize pointer-coarse:px-4 pointer-coarse:py-2.5 text-slate-500 transition-colors hover:text-slate-900 aria-selected:text-slate-900 aria-selected:after:absolute aria-selected:after:inset-x-3 aria-selected:after:-bottom-2 aria-selected:after:h-0.5 aria-selected:after:rounded-full aria-selected:after:bg-brand-600"
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className={tab === "chat" ? "flex min-h-0 flex-1" : "hidden"}>
        <ChatPanel {...p} mode={p.mode ?? "drawing"} visible={tab === "chat"} />
      </div>
      <MaterialPanel
        notebookId={p.notebookId}
        current={current}
        sections={p.sections}
        packMap={p.packMap ?? EMPTY}
        visible={tab === "material"}
        onJump={p.onJump}
        onPlay={(path) => {
          setPlay({ path, n: (play?.n ?? 0) + 1 });
          setTab("lecture");
        }}
      />
      <LecternPanel current={current} visible={tab === "lecture"} request={play} />
      <div className={tab === "section" ? "overflow-y-auto" : "hidden"}>
        <div className="border-b border-slate-200 p-4">
          <label className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-700">Follow iPad</span>
            <input
              type="checkbox"
              checked={p.follow}
              onChange={(e) => p.setFollow(e.target.checked)}
              className="h-4 w-4"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">
            {!p.ipad
              ? "No iPad seen yet."
              : ipadHere
                ? `iPad is on ${p.sections.find((s) => s.id === p.ipad!.data.sectionId)?.data.title ?? "this notebook"}`
                : "iPad is on another notebook."}
            {ipadHere && p.ipad && (
              <>
                {" "}
                · <PresenceAge at={p.ipad.data.at} />
              </>
            )}
          </p>
        </div>

        {current ? (
          <div className="border-b border-slate-200 p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold text-slate-800">
                {current.data.title ?? `Section ${idx + 1}`}
              </h2>
              <span className="text-xs text-slate-400">
                {idx + 1} / {p.sections.length}
              </span>
            </div>
            {showCopy && (
              <div
                className="mb-4 grid grid-cols-2 gap-2"
                data-testid="copy-buttons"
              >
                <button
                  className="btn btn-primary"
                  onClick={copyImage}
                >
                  Copy as image
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={copySource}
                >
                  Copy question text
                </button>
              </div>
            )}
            <EarlierQuestions
              key={current.id}
              sectionId={current.id}
              notebookId={p.notebookId}
              sections={p.sections}
            />

            {stats && (
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Stat label="strokes" value={String(stats.strokes)} />
                <Stat label="erased" value={String(stats.erased)} />
                <Stat label="pen time" value={fmt(stats.inkMs)} />
                <Stat label="first → last" value={fmt(stats.spanMs)} />
                <Stat label="visits" value={String(stats.focusEvents)} />
                <Stat
                  label="limit"
                  value={
                    current.data.timeLimitMinutes
                      ? `${current.data.timeLimitMinutes}m`
                      : "—"
                  }
                />
              </dl>
            )}

            {current.data.solution && (
              <div className="mt-4">
                <button
                  className="text-xs font-medium text-brand-700 hover:underline"
                  onClick={() => setShowSolution(!showSolution)}
                >
                  {showSolution ? "Hide solution" : "Reveal solution"}
                </button>
                {showSolution && (
                  <div
                    className="prose-pad mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[14px]"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(current.data.solution),
                    }}
                  />
                )}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-1.5">
              <button
                className="btn btn-secondary btn-sm"
                disabled={idx <= 0}
                onClick={() => swapSectionOrder(current, p.sections[idx - 1])}
              >
                Move up
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={idx >= p.sections.length - 1}
                onClick={() => swapSectionOrder(current, p.sections[idx + 1])}
              >
                Move down
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  insertSectionAfter(p.notebookId, current, p.sections)
                }
              >
                Blank page after
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={p.sections.length <= 1}
                onClick={() =>
                  confirm(
                    "Delete this section? (Its ink is kept in history.)",
                  ) && setDeleted([current.id], true)
                }
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}

        <nav className="p-2">
          <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Outline
          </div>
          {p.sections.map((s, i) => (
            <button
              key={s.id}
              onClick={() => p.onJump(s.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${s.id === current?.id ? "bg-brand-50 font-medium text-brand-800" : "hover:bg-slate-50"}`}
            >
              <span className="w-6 text-right text-xs tabular-nums text-slate-400">
                {i + 1}
              </span>
              <span className="truncate">
                {s.data.title ??
                  (s.data.blocks.length ? "Untitled" : "Blank page")}
              </span>
              {p.ipad?.data.sectionId === s.id && (
                <span className="ml-auto rounded-full bg-brand-100 px-1.5 text-[10px] font-medium text-brand-700">
                  iPad
                </span>
              )}
            </button>
          ))}
        </nav>

        {toast && (
          <div className="fixed bottom-4 right-4 z-50 rounded-xl bg-slate-900 px-4 py-2.5 text-white shadow-lift">
            {toast}
          </div>
        )}
      </div>
    </aside>
  );
}

const EMPTY = new Map<string, PackPage>();

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-2">
      <dd className="text-base font-semibold tabular-nums text-slate-800">
        {value}
      </dd>
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
