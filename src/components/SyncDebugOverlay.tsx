'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { deviceId, deviceKind } from '@/lib/db';
import { useSyncDebug } from '@/lib/settings';
import { getSyncTiming, requestSync } from '@/lib/sync';
import { useStoredState } from '@/lib/hooks';
import { MAX_EDITS, STAT_METRICS, clearSyncDebug, formatSyncDebugReport, getSyncDebugSnapshot, setSyncDebugEnabled, syncDebugStats, type SyncDebugRequest } from '@/lib/sync-debug';

type Snapshot = ReturnType<typeof getSyncDebugSnapshot>;
type Timing = ReturnType<typeof getSyncTiming>;
type Environment = { device: string; visibility: string; focused: boolean; online: boolean; standalone: boolean };
const ms = (value?: number) => value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} ms`;
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
const stages: [keyof SyncDebugRequest, string][] = [
  ['queueMs', 'Scheduled wait'], ['timerLateMs', 'Timer late (part of wait)'],
  ['readMs', 'Read local queue'], ['encodeMs', 'Encode upload'], ['httpMs', 'HTTP → response headers'],
  ['decodeMs', 'Body download + JSON'], ['applyMs', 'Apply to local storage'], ['totalMs', 'Request total (excludes wait)'],
  ['applyToPaintMs', 'Received storage → ink painted (separate)'],
];

function WindowStats() {
  const stats = syncDebugStats();
  return <details className="mt-3 text-xs" open>
    <summary className="cursor-pointer font-semibold">Averages over the last {MAX_EDITS} edits (ms)</summary>
    <div className="mt-1 grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 tabular-nums">
      <span />{stats.map(g => <span key={g.label} className="text-right font-medium">{g.label.split(' ')[0]} ({g.count})</span>)}
      {STAT_METRICS.map(([key, label]) => <div key={key} className="contents">
        <span className={label.startsWith(' ') ? 'pl-3' : ''}>{label.trim()}</span>
        {stats.map(g => <span key={g.label} className="text-right">{g.avg[key] === undefined ? '—' : Math.round(g.avg[key]!)}</span>)}
      </div>)}
      <span>New connections</span>{stats.map(g => <span key={g.label} className="text-right">{g.newConnections}/{g.count}</span>)}
    </div>
    <p className="mt-1 text-[10px] text-slate-500">Received = requests that applied ink, text or sections from another device; Sent = requests that uploaded them. Edit ages use device clocks and include clock skew.</p>
  </details>;
}

export function SyncDebugDetails({ snapshot, timing, environment, selected }: { snapshot: Snapshot; timing: Timing; environment: Environment; selected?: SyncDebugRequest }) {
  const waiting = timing.nextDueAt === null ? 'none' : `${Math.max(0, timing.nextDueAt - timing.end)} ms`;
  return <>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt>Device</dt><dd className="break-all">{environment.device}</dd>
      <dt>Browser</dt><dd>{environment.visibility} · {environment.focused ? 'focused' : 'unfocused'} · {environment.standalone ? 'PWA' : 'browser tab'}</dd>
      <dt>Connection</dt><dd>{environment.online ? 'online' : 'offline'} · realtime: {timing.realtimeStatus}</dd>
      <dt>Sync</dt><dd>{timing.status} · {timing.running ? 'request running' : 'no request running'}{timing.again ? ' · follow-up queued' : ''}</dd>
      <dt>Next request</dt><dd>{waiting} · {timing.scheduledReason}</dd>
      <dt>Failure backoff</dt><dd>{Math.max(0, timing.retryAt - timing.end)} ms · {timing.failures} failures</dd>
      <dt>Configured</dt><dd>send {timing.debounceMs} · visible {timing.visiblePollMs} · hidden {timing.hiddenPollMs} · retry {timing.retryBaseMs} ms</dd>
      <dt>Effective poll</dt><dd>{timing.effectivePollMs} ms</dd>
    </dl>
    {environment.visibility === 'hidden' && <p className="mt-3 rounded bg-amber-100 p-2 text-xs text-amber-950">This tab is hidden. Realtime is deliberately disconnected; receiving relies on the hidden poll interval. The browser can also throttle or suspend timers.</p>}
    {timing.realtimeStatus !== 'live' && environment.visibility === 'visible' && <p className="mt-3 rounded bg-amber-100 p-2 text-xs text-amber-950">Realtime is not live. Remote changes arrive through polling. Check the event log for access failures or reconnection.</p>}
    <WindowStats />
    {selected ? <div className="mt-3">
      <p className="text-xs font-semibold">#{selected.id} · {time(selected.at)} · {selected.trigger}</p>
      <p className="mt-1 text-xs">Started {selected.visibility} · {selected.phase} · HTTP {selected.status ?? '—'}</p>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
        {stages.map(([key, label]) => <div key={key} className="contents"><span>{label}</span><span>{ms(selected[key] as number | undefined)}</span></div>)}
      </div>
      {selected.ttfbMs !== undefined && <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs tabular-nums">
        <span>Network ({selected.protocol ?? 'protocol unknown'}) · {selected.newConnection ? 'new connection' : 'reused connection'}</span><span />
        <span className="pl-3">DNS + TCP + TLS</span><span>{ms(selected.connectMs)}</span>
        <span className="pl-3">Request sent → first byte</span><span>{ms(selected.ttfbMs)}</span>
        <span className="pl-3">Response download</span><span>{ms(selected.downloadMs)}</span>
      </div>}
      <p className="mt-2 text-xs">Batch: ↑ {selected.pushed ?? '—'} entities + {selected.events ?? '—'} events · ↓ {selected.pulled ?? '—'} entities · applied {selected.applied ?? '—'}. Cursor {selected.since ?? '—'} → {selected.cursor ?? '—'}{selected.more ? ' · more pages' : ''}.</p>
      {selected.serverRegion && <p className="mt-2 text-xs">Server region: {selected.serverRegion}{selected.serverBuild ? ` · backend build ${selected.serverBuild}` : ''}</p>}
      {selected.server && Object.keys(selected.server).length > 0 && <details className="mt-2 text-xs" open>
        <summary className="cursor-pointer font-semibold">Server timing (inside HTTP time)</summary>
        <div className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">{Object.entries(selected.server).map(([key, value]) => <div key={key} className="contents"><span>{key === 'auth' ? 'auth + database bootstrap' : key}</span><span>{ms(value)}</span></div>)}</div>
      </details>}
      {selected.remoteAgeMs !== undefined && <p className="mt-2 text-xs">Newest received edit age: {ms(selected.remoteAgeMs)}. Estimate from the edit’s logical clock; clock skew between devices affects this value.</p>}
      {!!selected.versions?.length && <details className="mt-2 text-xs"><summary className="cursor-pointer">Received entity versions</summary><ul className="mt-1 space-y-1 break-all font-mono">{selected.versions.map(version => <li key={version}>{version}</li>)}</ul></details>}
    </div> : <p className="mt-3 text-xs">Recording started. Make an edit or tap Sync now to collect a request breakdown.</p>}
    <details className="mt-3 text-xs" open>
      <summary className="cursor-pointer font-semibold">Recent events ({snapshot.events.length}/150)</summary>
      <ol className="mt-2 max-h-48 space-y-2 overflow-auto">{snapshot.events.slice().reverse().map(event => <li key={event.id} className="break-words border-b border-slate-200 pb-1">
        <span className="text-slate-500">{time(event.at)} · {event.kind}</span><br />{event.message}
        {Object.keys(event.details).length > 0 && <div className="break-all font-mono text-[10px] text-slate-600">{Object.entries(event.details).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value * 10) / 10 : value}`).join(' · ')}</div>}
      </li>)}</ol>
    </details>
    <p className="mt-3 text-[10px] text-slate-500">Ink paint events measure canvas work and time since received storage was applied, not physical screen presentation. These local traces do not measure true cross-device latency. Server totals overlap their phases; timer lateness overlaps scheduled wait. No extra sync requests are generated by this menu. Notebook text, ink points and credentials are excluded.</p>
  </>;
}

export function SyncDebugOverlay() {
  const [enabled, setEnabled] = useSyncDebug();
  const [expanded, setExpanded] = useState(true);
  const [selectedId, setSelectedId] = useState('latest');
  const [sample, setSample] = useState<{ snapshot: Snapshot; timing: Timing; environment: Environment } | null>(null);
  const [message, setMessage] = useState('');
  // Dragged position (top-left, px), per device; null keeps the bottom-right corner.
  const [pos, setPos] = useStoredState<{ x: number; y: number } | null>('padsync.syncDebugPos', null);
  const asideRef = useRef<HTMLElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const clamp = (x: number, y: number) => {
    const el = asideRef.current;
    const w = el?.offsetWidth ?? 200;
    return { x: Math.round(Math.min(Math.max(0, x), window.innerWidth - w)), y: Math.round(Math.min(Math.max(0, y), window.innerHeight - 44)) };
  };
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const r = asideRef.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current) setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const endDrag = () => { drag.current = null; };
  useEffect(() => {
    setSyncDebugEnabled(enabled);
    if (!enabled) return;
    const update = () => setSample({
      snapshot: getSyncDebugSnapshot(), timing: getSyncTiming(),
      environment: {
        device: `${deviceKind()} · ${deviceId()}`, visibility: document.visibilityState,
        focused: document.hasFocus(), online: navigator.onLine,
        standalone: !!window.matchMedia?.('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
      },
    });
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [enabled]);
  if (!enabled) return null;
  const snapshot = sample?.snapshot;
  const selected = selectedId === 'latest' ? snapshot?.requests.at(-1) : snapshot?.requests.find(request => String(request.id) === selectedId);
  function trace() {
    // Read immediately, so export includes events since the most recent UI refresh.
    return JSON.stringify({ exportedAt: new Date().toISOString(), environment: sample?.environment, timing: getSyncTiming(), ...getSyncDebugSnapshot() }, null, 2);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(trace()); setMessage('Trace copied.'); }
    catch { setMessage('Clipboard unavailable. Use Download trace.'); }
  }
  async function copyStats() {
    const env = sample?.environment, t = getSyncTiming();
    const report = formatSyncDebugReport([
      `Device: ${env?.device} · ${env?.visibility} · ${env?.focused ? 'focused' : 'unfocused'} · ${env?.standalone ? 'PWA' : 'browser tab'} · ${env?.online ? 'online' : 'offline'} · realtime ${t.realtimeStatus}`,
      `Config: send ${t.debounceMs} · visible ${t.visiblePollMs} · hidden ${t.hiddenPollMs} · retry ${t.retryBaseMs} · effective poll ${t.effectivePollMs} ms`,
    ]);
    try { await navigator.clipboard.writeText(report); setMessage('Stats copied.'); }
    catch { setMessage('Clipboard unavailable.'); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([trace()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `padsync-sync-debug-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // CSS keeps a saved spot on screen after the window shrinks or rotates.
  const placed = pos && { left: `min(${pos.x}px, calc(100vw - 8rem))`, top: `min(${pos.y}px, calc(100dvh - 44px))` };
  return <aside ref={asideRef} aria-label="Sync debug menu" className={`fixed z-[100] max-w-[calc(100vw-1rem)] ${placed ? '' : 'right-2'}`} style={placed ?? { bottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
    <div className="ml-auto flex w-fit rounded-t-lg bg-slate-900 text-xs font-medium text-white shadow-lg">
      <span role="button" tabIndex={-1} aria-label="Move sync debug menu" title="Drag to move · double-click to reset" className="flex min-h-11 cursor-move touch-none select-none items-center px-3" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => setPos(null)}>⠿</span>
      <button type="button" aria-expanded={expanded} aria-controls="sync-debug-panel" onClick={() => setExpanded(!expanded)} className="min-h-11 py-2 pr-3">
        Sync debug · {sample?.environment.visibility ?? '…'} · {sample?.timing.realtimeStatus ?? '…'} {expanded ? '▾' : '▴'}
      </button>
    </div>
    {expanded && <div id="sync-debug-panel" style={pos ? { maxHeight: `max(12rem, calc(100dvh - ${pos.y}px - 52px))` } : undefined} className="max-h-[65dvh] w-[min(30rem,calc(100vw-1rem))] overflow-auto rounded-b-lg rounded-tl-lg border border-slate-300 bg-white p-3 text-slate-900 shadow-xl">
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <button type="button" className="min-h-11 rounded border px-2" onClick={() => requestSync(0, 'debug sync now')}>Sync now</button>
        <button type="button" className="min-h-11 rounded border px-2 font-semibold" onClick={copyStats}>Copy stats</button>
        <button type="button" className="min-h-11 rounded border px-2" onClick={copy}>Copy trace</button>
        <button type="button" className="min-h-11 rounded border px-2" onClick={download}>Download trace</button>
        <button type="button" className="min-h-11 rounded border px-2" onClick={() => { clearSyncDebug(); setSelectedId('latest'); setMessage('Trace cleared.'); }}>Clear</button>
        <button type="button" className="min-h-11 rounded border px-2" onClick={() => setEnabled(false)}>Turn off</button>
      </div>
      {message && <p role="status" className="mb-2 text-xs">{message}</p>}
      {sample && <>
        <label className="mb-3 block text-xs">Request history
          <select className="mt-1 w-full rounded border bg-white p-2" value={selectedId} onChange={event => setSelectedId(event.target.value)}>
            <option value="latest">Latest request (live)</option>
            {sample.snapshot.requests.slice().reverse().map(request => <option key={request.id} value={request.id}>#{request.id} {time(request.at)} · {request.trigger} · ↑{request.pushed ?? 0} ↓{request.pulled ?? 0}</option>)}
          </select>
        </label>
        <SyncDebugDetails {...sample} selected={selected} />
      </>}
    </div>}
  </aside>;
}
