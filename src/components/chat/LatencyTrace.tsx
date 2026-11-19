"use client";
import { useState, useSyncExternalStore } from "react";
import type { Turn } from "@/lib/chat-types";
import { clientClock, formatMs, localMarks, timeline } from "@/lib/chat-trace";
import { Icon } from "../Icons";

/** A Mac (not an iPad, which also reports "MacIntel" but has touch points). */
export function useIsMac() {
  return useSyncExternalStore(
    () => () => {},
    () => /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1,
    () => false,
  );
}

/** Where a turn's time went, from the key press to the reply on screen (src/lib/chat-trace.ts). */
export function LatencyTrace({ turn: t }: { turn: Turn }) {
  const [copied, setCopied] = useState(false);
  const trace = t.trace ?? {};
  const mine = localMarks(t.jobId);
  const { stages, firstWords, total } = timeline(trace, mine, clientClock()?.offset ?? 0);
  const span = Math.max(1, total ?? 0, ...stages.map((s) => s.start + s.ms));
  const rtts = [
    trace["client.clock_rtt"] !== undefined && `device ±${formatMs(trace["client.clock_rtt"] / 2)}`,
    trace["bridge.claim_rtt"] !== undefined && `Mac bridge ±${formatMs(trace["bridge.claim_rtt"] / 2)}`,
  ].filter(Boolean);
  const updates = trace["bridge.updates"];
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-medium text-slate-800">Latency trace</span>
        {firstWords !== undefined && <span>First words on screen <b className="tabular-nums text-slate-800">{formatMs(firstWords)}</b></span>}
        {total !== undefined && <span>Reply complete <b className="tabular-nums text-slate-800">{formatMs(total)}</b></span>}
        <button
          className="ml-auto flex items-center gap-1 text-slate-500 hover:text-slate-800"
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify({ jobId: t.jobId, agent: t.agent, options: t.options, status: t.status, trace, device: mine, stages }, null, 2))
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
          }
        >
          <Icon name={copied ? "tick" : "copy"} /> {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      {stages.length === 0 ? (
        <p>No timings yet. Turns sent before tracing was added, or by an older bridge, have none.</p>
      ) : (
        <ol className="space-y-1">
          {stages.map((s) => (
            <li key={s.label} className="grid grid-cols-[minmax(0,14rem)_4.5rem_1fr] items-center gap-2">
              <span className="truncate" title={s.label}>{s.label}</span>
              <span className={`text-right tabular-nums ${s.ms < 0 ? "text-amber-700" : "text-slate-800"}`}>{formatMs(s.ms)}</span>
              <span className="relative h-2.5 rounded-sm bg-slate-200/60">
                <span
                  className={`absolute inset-y-0 rounded-sm ${s.network ? "bg-sky-400" : "bg-brand-500"}`}
                  style={{ left: `${Math.max(0, (s.start / span) * 100)}%`, width: `max(2px, ${(Math.max(0, s.ms) / span) * 100}%)` }}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="text-slate-400">
        <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky-400" /> network or polling
        <span className="ml-3 mr-1 inline-block h-2 w-2 rounded-sm bg-brand-500" /> work on a machine
        {updates !== undefined && updates > 0 && ` · ${updates} bridge updates, ${formatMs(trace["bridge.update_ms"] / updates)} each`}
        {rtts.length > 0 && ` · clocks aligned to the server, ${rtts.join(", ")}`}
      </p>
    </div>
  );
}
