"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deviceId, deviceKind } from "@/lib/db";
import { useSyncStatus } from "@/lib/hooks";
import { LECTERN_URL_DEFAULT, useLecternUrl } from "@/lib/lectern";
import { useGestureBindings, useGestureTuning, useShowCopyButtons, useSyncDebug, useThemePreference } from "@/lib/settings";
import { DEFAULT_GESTURES, DEFAULT_TUNING, GESTURES, TUNING_RANGES, actionsFor, type GestureAction } from "@/lib/touch-gestures";
import { THEME_PREFERENCES } from "@/lib/theme";
import { requestSync, resetCursor, stopSync } from "@/lib/sync";
import { SyncTimingSettings } from "./SyncTimingSettings";
import { DeviceTokens } from "./DeviceTokens";
import { Icon } from "./Icons";
import { LassoSettingsPanel } from "./LassoSettingsPanel";

interface Status {
  db: boolean;
  auth: boolean;
  authed: boolean;
  login: string | null;
  allowed: string;
  canvas: { configured: boolean; expiresAt: string | null };
}

interface CanvasCheck {
  ok: boolean;
  name?: string;
  error?: string;
}

export default function SettingsView() {
  const sync = useSyncStatus();
  const [showCopy, setShowCopy] = useShowCopyButtons();
  const [syncDebug, setSyncDebug] = useSyncDebug();
  const [theme, setTheme] = useThemePreference();
  const [lectern, setLectern] = useLecternUrl();
  const [status, setStatus] = useState<Status | null>(null);
  const [authError] = useState(() => new URLSearchParams(window.location.search).get("auth_error"));
  const [canvas, setCanvas] = useState<CanvasCheck | null>(null);

  const load = () =>
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (status?.authed) requestSync(0);
  }, [status?.authed]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    stopSync();
    window.location.reload();
  };

  const checkCanvas = async () => {
    setCanvas(null);
    const r = await fetch("/api/canvas/status", { method: "POST" });
    setCanvas(await r.json());
  };

  const [now] = useState(() => Date.now());
  const daysLeft = status?.canvas.expiresAt ? Math.ceil((new Date(status.canvas.expiresAt).getTime() - now) / 86_400_000) : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-16 pt-5 text-sm sm:px-8 sm:pt-8">
      <Link href="/" className="btn btn-ghost -ml-2 px-2"><Icon name="back" className="text-lg" />Library</Link>
      <h1 className="mb-8 mt-4 text-3xl font-semibold tracking-tight text-slate-900">Settings</h1>

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Account and sync</h2>
        {status && !status.auth ? (
          <p className="text-slate-600">
            Set <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code> and <code>SESSION_SECRET</code> in the Vercel project to enable sync.
          </p>
        ) : status?.authed ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-emerald-700">Signed in as @{status.login}</p>
            <button className="btn btn-secondary" onClick={logout}>Sign out</button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-slate-600">Sign in to sync notebooks between devices. Only @{status?.allowed ?? "…"} can sign in.</p>
            <a href="/api/auth/github?next=/settings" className="btn btn-primary shrink-0">Sign in with GitHub</a>
          </div>
        )}
        {authError && <p className="mt-2 text-rose-700">{authError}</p>}
        <div className="mt-3">
          <Row k="Status" v={sync.status} />
          <Row k="Last synced" v={sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString() : "—"} />
          <Row k="Database" v={status ? (status.db ? "connected" : "not configured (DATABASE_URL)") : "unreachable"} />
          <Row k="This device" v={`${deviceKind()} · ${deviceId()}`} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => requestSync(0)}>Sync now</button>
          <button className="btn btn-secondary" onClick={() => resetCursor()} title="Fetch every notebook from the server again">Re-download everything</button>
        </div>
      </section>

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Appearance</h2>
        <Setting title="Theme" hint={<>System follows this device&rsquo;s light or dark setting. Pages stay light so ink keeps its colours.</>}>
          <div className="segmented shrink-0" role="group" aria-label="Theme">
            {THEME_PREFERENCES.map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{THEME_LABELS[t]}</button>)}
          </div>
        </Setting>
      </section>

      <section className="card mb-5 space-y-4 p-5">
        <h2 className="text-base font-semibold text-slate-900">Notebook</h2>
        <Setting label title="Show copy buttons" hint={<>&ldquo;Copy as image&rdquo; and &ldquo;Copy question text&rdquo; in the side panel, for pasting into a chat by hand. Ask AI through the Mac bridge doesn&rsquo;t need them.</>}>
          <input type="checkbox" className="switch" checked={showCopy} onChange={(e) => setShowCopy(e.target.checked)} />
        </Setting>
        <label className="block">
          <span className="block text-slate-800">Lectern address</span>
          <span className="block text-xs text-slate-500">The lecture player on your Mac, shown in the side panel&rsquo;s Lecture tab. On this Mac: {LECTERN_URL_DEFAULT}. On an iPad: the Mac&rsquo;s address after <code>npm run start:lan</code>, e.g. http://your-mac.local:4747.</span>
          <input aria-label="Lectern address" type="url" defaultValue={lectern} placeholder={LECTERN_URL_DEFAULT} onBlur={(e) => { const v = e.target.value.trim().replace(/\/+$/, ""); if (/^https?:\/\/[^\s/]+/.test(v)) setLectern(v); else e.target.value = lectern; }} className="mt-2 block w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
      </section>

      <GestureSettings />

      <section id="lasso" className="card mb-5 scroll-mt-4 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Lasso</h2>
        <LassoSettingsPanel ipad={deviceKind() === "ipad"} />
      </section>

      {status?.authed && <SyncTimingSettings />}
      {status?.authed && <DeviceTokens />}

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">NUS Canvas</h2>
        <Row k="Token" v={status?.canvas.configured ? "configured on server" : "not set (CANVAS_TOKEN)"} />
        <Row k="Expires" v={daysLeft == null ? "—" : daysLeft > 0 ? `in ${daysLeft} days` : "expired: generate a new one"} />
        <button className="btn btn-secondary mt-3" disabled={!status?.canvas.configured} onClick={checkCanvas}>
          Check token
        </button>
        {canvas && <p className={`mt-2 ${canvas.ok ? "text-emerald-700" : "text-rose-700"}`}>{canvas.ok ? `Connected as ${canvas.name}` : canvas.error}</p>}
        <p className="mt-3 text-xs text-slate-500">
          NUS caps tokens at 30 days. Create a new one at canvas.nus.edu.sg → Account → Settings → Approved Integrations, then update CANVAS_TOKEN and
          CANVAS_TOKEN_EXPIRES in Vercel.
        </p>
      </section>

      <section className="card space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Troubleshooting</h2>
          <p className="mt-1 text-xs text-slate-500">For checking sync and Pencil problems. Nothing here changes your notebooks.</p>
        </div>
        <Setting label title="Show sync debug menu" hint="Show timing, visibility and realtime diagnostics on this device. Enable separately on the iPad and Mac. Recording stays in memory and stops when switched off.">
          <input type="checkbox" className="switch" checked={syncDebug} onChange={e => setSyncDebug(e.target.checked)} />
        </Setting>
        <Setting title={<>Pencil test <span className="text-slate-500">· what Safari sends</span></>} hint="Record the raw Pencil events this browser delivers (position, pressure, tilt, timing) and save them as a file. Start here to report a writing problem.">
          <Link href="/pencil-test" className="btn btn-secondary shrink-0">Open</Link>
        </Setting>
        <Setting title={<>Pencil lab <span className="text-slate-500">· how padSync draws it</span></>} hint="Write with your notebook pen, then replay the recording at any speed to see how strokes are processed. Nothing written there is saved.">
          <Link href="/pencil-lab" className="btn btn-secondary shrink-0">Open</Link>
        </Setting>
      </section>
    </main>
  );
}

/** What each finger gesture does in a notebook on the iPad. */
function GestureSettings() {
  const [bindings, setBindings] = useGestureBindings();
  const [tuning, setTuning] = useGestureTuning();
  const changed = GESTURES.some((g) => bindings[g.kind] !== DEFAULT_GESTURES[g.kind]) || JSON.stringify(tuning) !== JSON.stringify(DEFAULT_TUNING);
  return (
    <section id="gestures" className="card mb-5 scroll-mt-4 space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Touch gestures</h2>
          <p className="mt-1 text-xs text-slate-500">
            Finger gestures in a notebook on the iPad. Gestures on the page with one finger are ignored just after you use the Pencil, so a resting palm doesn&rsquo;t set them off. Saved on this device only.
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm shrink-0"
          disabled={!changed}
          onClick={() => {
            setBindings(DEFAULT_GESTURES);
            setTuning(DEFAULT_TUNING);
          }}
        >
          Reset
        </button>
      </div>
      {GESTURES.map((g) => (
        <Setting key={g.kind} title={g.label} hint={g.hint}>
          <select
            className="field h-11 w-auto max-w-[14rem] shrink-0 py-0 text-sm"
            aria-label={g.label}
            value={bindings[g.kind]}
            onChange={(e) => setBindings({ ...bindings, [g.kind]: e.target.value as GestureAction })}
          >
            {actionsFor(g.kind).map((a) => (
              <option key={a.action} value={a.action}>
                {a.label}
              </option>
            ))}
          </select>
        </Setting>
      ))}
      {bindings.fingerHold === "lassoHold" && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Lasso while held: hold a finger on the page until the ring fills, then drag around what you want and lift. It works whatever tool is selected, and a second finger cancels it.
        </p>
      )}

      <details className="group border-t border-slate-100 pt-3">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 font-medium text-slate-800">
          <Icon name="chevronRight" className="text-slate-400 transition-transform group-open:rotate-90" />
          Fine-tune
        </summary>
        <div className="mt-2 space-y-4">
          {(Object.keys(TUNING_RANGES) as (keyof typeof TUNING_RANGES)[]).map((k) => {
            const r = TUNING_RANGES[k];
            return (
              <label key={k} className="block">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-800">{r.label}</span>
                  <span className="flex items-baseline gap-2">
                    {tuning[k] !== DEFAULT_TUNING[k] && (
                      <button type="button" className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setTuning({ ...tuning, [k]: DEFAULT_TUNING[k] })}>
                        Reset
                      </button>
                    )}
                    <span className="tabular-nums text-slate-600">
                      {tuning[k]} {r.unit}
                    </span>
                  </span>
                </span>
                <span className="block text-xs text-slate-500">{r.hint}</span>
                <input
                  type="range"
                  aria-label={r.label}
                  min={r.min}
                  max={r.max}
                  step={r.step}
                  value={tuning[k]}
                  onChange={(e) => setTuning({ ...tuning, [k]: Number(e.target.value) })}
                  className="mt-1 block h-8 w-full"
                />
              </label>
            );
          })}
          <Setting label title="Show what a gesture did" hint="A short note under the toolbar, such as Undo or Lasso, so a stray gesture is noticed.">
            <input type="checkbox" className="switch" checked={tuning.showNote} onChange={(e) => setTuning({ ...tuning, showNote: e.target.checked })} />
          </Setting>
        </div>
      </details>
    </section>
  );
}

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

// One setting: a title and a short explanation on the left, its control on the right. `label`
// makes the whole row a <label>, so tapping the text flips a switch.
function Setting({ title, hint, label, children }: { title: React.ReactNode; hint: React.ReactNode; label?: boolean; children: React.ReactNode }) {
  const Tag = label ? "label" : "div";
  return (
    <Tag className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-slate-800">{title}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
      {children}
    </Tag>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 last:border-0">
      <span className="text-slate-500">{k}</span>
      <span className="min-w-0 truncate text-right font-medium text-slate-800">{v}</span>
    </div>
  );
}
