"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deviceId, deviceKind } from "@/lib/db";
import { useStoredState, useSyncStatus } from "@/lib/hooks";
import { useShowCopyButtons, useSyncDebug, useThemePreference } from "@/lib/settings";
import { THEME_PREFERENCES } from "@/lib/theme";
import { requestSync, resetCursor, stopSync } from "@/lib/sync";
import { SyncTimingSettings } from "./SyncTimingSettings";
import { DeviceTokens } from "./DeviceTokens";
import { Icon } from "./Icons";

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
  const [idleMs, setIdleMs] = useStoredState("padsync.layoutIdleMs", 15000);
  const sync = useSyncStatus();
  const [showCopy, setShowCopy] = useShowCopyButtons();
  const [syncDebug, setSyncDebug] = useSyncDebug();
  const [theme, setTheme] = useThemePreference();
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
        <h2 className="mb-3 text-base font-semibold text-slate-900">Appearance</h2>
        <div className="flex items-center justify-between gap-3">
          <span><span className="block text-slate-800">Theme</span>
            <span className="block text-xs text-slate-500">System follows this device&rsquo;s light or dark setting. Pages stay light so ink keeps its colours.</span></span>
          <div className="segmented shrink-0" role="group" aria-label="Theme">
            {THEME_PREFERENCES.map((t) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{THEME_LABELS[t]}</button>)}
          </div>
        </div>
      </section>
      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Layout</h2>
        <p className="text-xs text-slate-500">Starts in Auto by default.</p>
        <label>Idle delay: {idleMs / 1000} s<input aria-label="Layout idle delay" type="range" min="5" max="120" value={idleMs / 1000} onChange={e => setIdleMs(Number(e.target.value) * 1000)} className="mt-2 block w-full" /></label>
      </section>
      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Sync</h2>
        <Row k="Status" v={sync.status} />
        <Row k="Last synced" v={sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString() : "—"} />
        <Row k="Database" v={status ? (status.db ? "connected" : "not configured (DATABASE_URL)") : "unreachable"} />
        <Row k="This device" v={`${deviceKind()} · ${deviceId()}`} />
        <div className="mt-3 flex gap-2">
          <button className="btn btn-secondary" onClick={() => requestSync(0)}>Sync now</button>
          <button className="btn btn-secondary" onClick={() => resetCursor()}>Re-download everything</button>
        </div>
      </section>

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Diagnostics</h2>
        <label className="flex items-center justify-between gap-3">
          <span><span className="block text-slate-800">Show sync debug menu</span>
            <span className="block text-xs text-slate-500">Show timing, visibility and realtime diagnostics on this device. Enable separately on the iPad and Mac. Recording stays in memory and stops when switched off.</span></span>
          <input type="checkbox" className="switch" checked={syncDebug} onChange={e => setSyncDebug(e.target.checked)} />
        </label>
      </section>

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Sign in</h2>
        {status && !status.auth ? (
          <p className="text-slate-600">
            Set <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code> and <code>SESSION_SECRET</code> in the Vercel project to enable sync.
          </p>
        ) : status?.authed ? (
          <div className="flex items-center justify-between">
            <p className="text-emerald-700">Signed in as @{status.login}</p>
            <button className="btn btn-secondary" onClick={logout}>Sign out</button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-slate-600">Only @{status?.allowed ?? "…"} can sign in.</p>
            <a href="/api/auth/github?next=/settings" className="btn btn-primary">Sign in with GitHub</a>
          </div>
        )}
        {authError && <p className="mt-2 text-rose-700">{authError}</p>}
      </section>

      {status?.authed && <SyncTimingSettings />}
      {status?.authed && <DeviceTokens />}

      <section className="card mb-5 p-5">
        <h2 className="mb-3 text-base font-semibold text-slate-900">Notebook</h2>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-slate-800">Show copy buttons</span>
            <span className="block text-xs text-slate-500">&ldquo;Copy as image&rdquo; and &ldquo;Copy question text&rdquo; in the side panel, for pasting into a chat by hand. Ask AI through the Mac bridge doesn&rsquo;t need them.</span>
          </span>
          <input type="checkbox" className="switch" checked={showCopy} onChange={(e) => setShowCopy(e.target.checked)} />
        </label>
      </section>

      <section className="card p-5">
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
    </main>
  );
}

const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 last:border-0">
      <span className="text-slate-500">{k}</span>
      <span className="min-w-0 truncate text-right font-medium text-slate-800">{v}</span>
    </div>
  );
}
