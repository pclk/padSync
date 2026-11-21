"use client";

import { useEffect, useRef, useState } from "react";
import { lecternSrc, pdfLecternLinks, useLecternUrl, type LecternLink } from "@/lib/lectern";
import type { SectionEntity } from "@/lib/types";

interface State { title: string; label: string; t: number; chapter: string | null; url: string }

/**
 * The Lecture tab: Lectern's player (served from the Mac) beside the page, and the lecture links printed on the
 * page you're on, so a question's worked example is one tap away. The iframe stays mounted while hidden, so
 * switching tabs doesn't stop or reload the video.
 */
export function LecternPanel({ current, visible, request }: {
  current: SectionEntity | null;
  visible: boolean;
  /** A link to play, from elsewhere in the panel (the Material tab); `n` changes for each new request. */
  request?: { path: string; n: number } | null;
}) {
  const [base] = useLecternUrl();
  const [path, setPath] = useState("/");
  const [found, setFound] = useState<{ key: string; links: LecternLink[] } | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  // don't reach for the Mac until the tab is first opened
  const [opened, setOpened] = useState(visible);
  if (visible && !opened) setOpened(true);
  const pdf = current?.data.pdf;
  const key = pdf ? `${pdf.documentId}:${pdf.page}` : "";
  const links = found?.key === key ? found.links : [];

  useEffect(() => {
    if (!pdf) return;
    let live = true;
    pdfLecternLinks(pdf).then((l) => live && setFound({ key: `${pdf.documentId}:${pdf.page}`, links: l }), () => {});
    return () => { live = false; };
  }, [pdf]);

  // The player reports where it is about once a second.
  useEffect(() => {
    const origin = new URL(base).origin;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.data?.type !== "lectern:state") return;
      setState(e.data as State);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [base]);

  // Navigate inside the player when it's already loaded, so it keeps its state and doesn't flash.
  const open = (next: string) => {
    const win = frame.current?.contentWindow;
    if (win && loaded.current) win.postMessage({ type: "lectern:open", url: `${next}${next.includes("?") ? "&" : "?"}embed=1` }, new URL(base).origin);
    else setPath(next);
  };

  const lastRequest = useRef(0);
  useEffect(() => {
    if (!request || request.n === lastRequest.current) return;
    lastRequest.current = request.n;
    open(request.path);
    // open() only reads refs and the address; re-running it for a new address isn't wanted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const copy = async () => {
    if (!state) return;
    await navigator.clipboard.writeText(state.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };

  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {links.length > 0 && (
        <div className="shrink-0 border-b border-slate-200 p-2">
          <p className="px-1 pb-1 text-xs font-medium text-slate-500">Worked in lectures (this page)</p>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {links.map((l) => (
              <li key={l.path}>
                <button type="button" onClick={() => open(l.path)} className="w-full rounded-md bg-amber-50 px-2 py-1.5 text-left text-xs text-slate-800 ring-1 ring-amber-300 hover:bg-amber-100 pointer-coarse:py-2.5">
                  {l.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {opened && <iframe ref={frame} onLoad={() => { loaded.current = true; }} title="Lectern lecture player" src={lecternSrc(base, path)} allow="fullscreen; autoplay; clipboard-write" className="min-h-0 w-full flex-1 border-0 bg-slate-950" />}
      <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
        <span className="min-w-0 flex-1 truncate">{state ? `${state.label} · ${state.chapter ?? state.title}` : `Lectern at ${base}`}</span>
        {state && <button type="button" className="rounded px-2 py-1 hover:bg-slate-100" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>}
        <a className="rounded px-2 py-1 hover:bg-slate-100" href={state?.url ?? new URL(path, base).toString()} target="_blank" rel="noreferrer">Open ↗</a>
      </div>
    </div>
  );
}
