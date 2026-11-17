'use client';
import { useEffect, useState } from 'react';
import { getSyncTiming, setSyncConfig } from '@/lib/sync';
import { DEFAULT_SYNC_CONFIG, SYNC_FIELDS, validSyncField, normalizeSyncConfig, type SyncConfig } from '@/lib/sync-policy';

const keys = Object.keys(SYNC_FIELDS) as (keyof SyncConfig)[];
const draftOf = (config: SyncConfig) => Object.fromEntries(keys.map(key => [key, String(config[key])])) as Record<keyof SyncConfig, string>;

export function SyncTimingSettings() {
  const [admin, setAdmin] = useState(false);
  const [draft, setDraft] = useState(draftOf(DEFAULT_SYNC_CONFIG));
  const [sample, setSample] = useState<ReturnType<typeof getSyncTiming> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/sync-config', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error('Sign in and connect the database to configure sync.');
      return r.json();
    }).then(data => {
      if (live) { const config = normalizeSyncConfig(data); setAdmin(data.admin); setDraft(draftOf(config)); setSyncConfig(config); }
    }).catch(e => { if (live) setMessage(e.message); });
    const update = () => setSample(getSyncTiming());
    update(); const timer = setInterval(update, 1000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const valid = keys.every(key => draft[key].trim() !== '' && validSyncField(key, Number(draft[key])));
  async function save() {
    if (!valid) return;
    setBusy(true); setMessage('');
    try {
      const body = Object.fromEntries(keys.map(key => [key, Number(draft[key])]));
      const r = await fetch('/api/sync-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Could not save sync timing.');
      const saved = normalizeSyncConfig(await r.json()); setSyncConfig(saved); setDraft(draftOf(saved)); setSample(getSyncTiming());
      setMessage('Saved on this device. Other online devices adopt these settings within about a minute, or when you return to their tab.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="mb-3 font-semibold text-slate-800">Sync timing</h2>
    <p className="text-sm">An edit waits for the send delay on one device, then the receive interval on the other, plus network and server time. Lower the visible receive interval to make iPad ↔ Mac updates arrive sooner.</p>
    <p className="mt-2 text-sm text-slate-600">Shorter intervals use more requests, battery and data, even when you are not editing. Background sync depends on the browser keeping the tab running; a locked or sleeping device may stop syncing.</p>
    {admin && <>
      <div className="my-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={() => setDraft(draftOf({ debounceMs: 100, visiblePollMs: 250, hiddenPollMs: 2000, retryBaseMs: 500 }))}>Fast preset</button>
        <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={() => setDraft(draftOf(DEFAULT_SYNC_CONFIG))}>Default preset</button>
      </div>
      <div className="space-y-4">{keys.map(key => {
        const field = SYNC_FIELDS[key];
        const invalid = !validSyncField(key, Number(draft[key])) || !draft[key].trim();
        return <div key={key}>
          <label className="flex flex-wrap items-center gap-2 text-sm font-medium" htmlFor={`sync-${key}`}>{field.label} (ms)
            <input id={`sync-${key}`} type="number" min={field.min} max={field.max} step={1} disabled={busy} aria-invalid={invalid} aria-describedby={`sync-${key}-help`} className="w-28 rounded border px-2 py-1" value={draft[key]} onChange={e => setDraft(previous => ({ ...previous, [key]: e.target.value }))} />
          </label>
          <p id={`sync-${key}-help`} className="mt-1 text-xs text-slate-600">{field.help} Range: {field.min}–{field.max} ms. Active: {sample?.[key] ?? field.default} ms.</p>
          {invalid && <p className="text-xs text-rose-700">Enter a whole number from {field.min} to {field.max}.</p>}
        </div>;
      })}</div>
      <button type="button" className="mt-4 rounded border px-3 py-1 disabled:opacity-40" disabled={!valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save for all devices'}</button>
      <p className="mt-2 text-xs text-slate-500">Presets fill in the controls; save to apply them. Send delay starts at the first edit; further edits join the batch without postponing it. Earlier polling can send it sooner.</p>
    </>}
    {!admin && <p className="mt-2 text-sm text-slate-500">Only GitHub admin @pclk can change these settings.</p>}
    {sample && <div className="mt-4 text-xs text-slate-600">
      <p>Active timings on this tab: send {sample.debounceMs} ms · visible receive {sample.visiblePollMs} ms · hidden receive {sample.hiddenPollMs} ms · initial retry {sample.retryBaseMs} ms.</p>
      <p className="mt-2">Observed: {sample.requests} sync requests and {sample.edits.length} local sync triggers over {Math.round((sample.end - sample.start) / 1000)} seconds (up to 5 minutes). Triggers include ink, typed changes, analytics and presence. {sample.traceTruncated && 'Trace limit reached; older entries omitted.'}</p>
      <p className="mt-2">Intervals start after each completed request. Network and server time add latency. Configuration checks run about once a minute while syncing. This counter measures requests on this tab, not end-to-end latency or database cost.</p>
    </div>}
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}
  </section>;
}
