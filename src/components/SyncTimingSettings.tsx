'use client';
import { useEffect, useState } from 'react';
import { getSyncTiming, setSyncDebounce } from '@/lib/sync';
import { DEFAULT_DEBOUNCE_MS, validDebounce, replaySyncRequests } from '@/lib/sync-policy';

export function SyncTimingSettings() {
  const [admin, setAdmin] = useState(false);
  const [current, setCurrent] = useState(DEFAULT_DEBOUNCE_MS);
  const [proposed, setProposed] = useState(String(DEFAULT_DEBOUNCE_MS));
  const [sample, setSample] = useState<ReturnType<typeof getSyncTiming> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/sync-config', {cache:'no-store'}).then(async r => {
      if (!r.ok) throw new Error('Sign in and connect the database to configure sync.');
      return r.json();
    }).then(data => { if (live) { setAdmin(data.admin); setCurrent(data.debounceMs); setProposed(String(data.debounceMs)); setSyncDebounce(data.debounceMs); } }).catch(e => { if (live) setMessage(e.message); });
    const update = () => { const timing = getSyncTiming(); setSample(timing); setCurrent(timing.debounceMs); };
    update(); const timer = setInterval(update, 1000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const value = Number(proposed), valid = validDebounce(value);
  const baseline = sample ? replaySyncRequests(sample.edits, sample.start, sample.end, current) : 0;
  const candidate = sample && valid ? replaySyncRequests(sample.edits, sample.start, sample.end, value) : 0;
  async function save() {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/sync-config', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({debounceMs:value})});
      if (!r.ok) throw new Error((await r.json()).error ?? 'Could not save sync timing.');
      const saved = await r.json(); setCurrent(saved.debounceMs); setSyncDebounce(saved.debounceMs);
      setMessage('Saved. Other online devices adopt this within about a minute.');
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  return <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="mb-3 font-semibold text-slate-800">Sync timing</h2>
    <p>Current write coalescing window: {current} ms. The first edit starts the window; more edits join that batch without postponing it. Earlier polling can send it sooner.</p>
    {admin && <div className="my-3 flex items-center gap-2"><label>Debounce (ms) <input aria-label="Sync debounce milliseconds" type="number" min={100} max={10000} step={1} className="w-24 rounded border px-2 py-1" value={proposed} onChange={e=>setProposed(e.target.value)} /></label><button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save for all devices'}</button></div>}
    {!admin && <p className="mt-2 text-slate-500">Only GitHub admin @pclk can change this setting.</p>}
    {sample && <div className="mt-3 text-xs text-slate-600">
      <p>Observed on this tab: {sample.requests} sync HTTP requests and {sample.edits.length} local sync triggers over {Math.round((sample.end-sample.start)/1000)} seconds (up to 5 minutes). Triggers can include ink, typed changes, analytics and presence; they are not unique edits.</p>
      {valid && sample.edits.length > 0 && !sample.traceTruncated ? <>
        <p className="mt-2">Replaying those triggers: {baseline} requests at {current} ms → {candidate} at {value} ms; change {candidate-baseline >= 0 ? '+' : ''}{candidate-baseline}{baseline ? ` (${Math.round((candidate/baseline-1)*100)}%)` : ' (percentage unavailable: zero baseline)' }.</p>
        <svg viewBox="0 0 300 58" role="img" aria-label={`Modeled sync requests: current ${baseline}, proposed ${candidate}`} className="mt-2 h-16 w-full"><text x="0" y="15" fontSize="12">Current</text><rect x="75" y="3" width={210*baseline/Math.max(1,baseline,candidate)} height="18" fill="#64748b"/><text x="0" y="45" fontSize="12">Proposed</text><rect x="75" y="33" width={210*candidate/Math.max(1,baseline,candidate)} height="18" fill="#2563eb"/></svg>
      </> : <p className="mt-2">{sample.traceTruncated ? 'Trace limit reached; estimate unavailable.' : 'Make some notebook changes to collect a local workload sample.'}</p>}
      <p className="mt-2">This is a request-count model for this tab, assuming a continuously visible, connected device, immediate responses and no pagination, manual syncs or retries. It includes a pull every 2 seconds after the previous request. Hidden tabs poll every 15 seconds. Network and server time lengthen these intervals. Configuration refresh adds at most about one GET per minute per active tab, plus settings-page reads. These are not estimates of server CPU, database work, fleet traffic or money; payload size, concurrent devices and measured server timings are needed for those. Debounce affects batching, not the number of notebook entities that must eventually be stored.</p>
    </div>}
    {message && <p role="status" className="mt-2 text-xs">{message}</p>}
  </section>;
}
