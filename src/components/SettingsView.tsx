"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deviceId, deviceKind } from "@/lib/db";
import { useSyncStatus } from "@/lib/hooks";
import { useShowCopyButtons, useSyncDebug } from "@/lib/settings";
import { requestSync, resetCursor, stopSync } from "@/lib/sync";
import { SyncTimingSettings } from "./SyncTimingSettings";
import { DeviceTokens } from "./DeviceTokens";

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
    <main className="mx-auto max-w-2xl px-6 py-10 text-sm">
      <Link href="/" className="text-slate-500">‹ Library</Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold text-slate-900">Settings</h1>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Sync</h2>
        <Row k="Status" v={sync.status} />
        <Row k="Last synced" v={sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleTimeString() : "—"} />
        <Row k="Database" v={status ? (status.db ? "connected" : "not configured (DATABASE_URL)") : "unreachable"} />
        <Row k="This device" v={`${deviceKind()} · ${deviceId()}`} />
        <div className="mt-3 flex gap-2">
          <button className="rounded-lg border px-3 py-1.5" onClick={() => requestSync(0)}>Sync now</button>
          <button className="rounded-lg border px-3 py-1.5" onClick={() => resetCursor()}>Re-download everything</button>
        </div>
      </section>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Diagnostics</h2>
        <label className="flex items-center justify-between gap-3">
          <span><span className="block text-slate-800">Show sync debug menu</span>
            <span className="block text-xs text-slate-500">Show timing, visibility and realtime diagnostics on this device. Enable separately on the iPad and Mac. Recording stays in memory and stops when switched off.</span></span>
          <input type="checkbox" className="h-4 w-4 shrink-0" checked={syncDebug} onChange={e => setSyncDebug(e.target.checked)} />
        </label>
      </section>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Sign in</h2>
        {status && !status.auth ? (
          <p className="text-slate-600">
            Set <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code> and <code>SESSION_SECRET</code> in the Vercel project to enable sync.
          </p>
        ) : status?.authed ? (
          <div className="flex items-center justify-between">
            <p className="text-emerald-700">Signed in as @{status.login}</p>
            <button className="rounded-lg border px-3 py-1.5" onClick={logout}>Sign out</button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-slate-600">Only @{status?.allowed ?? "…"} can sign in.</p>
            <a href="/api/auth/github?next=/settings" className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">Sign in with GitHub</a>
          </div>
        )}
        {authError && <p className="mt-2 text-rose-700">{authError}</p>}
      </section>

      {status?.authed && <SyncTimingSettings />}
      {status?.authed && <DeviceTokens />}

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">Notebook</h2>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-slate-800">Show copy buttons</span>
            <span className="block text-xs text-slate-500">&ldquo;Copy as image&rdquo; and &ldquo;Copy question text&rdquo; in the side panel, for pasting into a chat by hand. Ask AI through the Mac bridge doesn&rsquo;t need them.</span>
          </span>
          <input type="checkbox" className="h-4 w-4 shrink-0" checked={showCopy} onChange={(e) => setShowCopy(e.target.checked)} />
        </label>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-semibold text-slate-800">NUS Canvas</h2>
        <Row k="Token" v={status?.canvas.configured ? "configured on server" : "not set (CANVAS_TOKEN)"} />
        <Row k="Expires" v={daysLeft == null ? "—" : daysLeft > 0 ? `in ${daysLeft} days` : "expired: generate a new one"} />
        <button className="mt-3 rounded-lg border px-3 py-1.5 disabled:opacity-40" disabled={!status?.canvas.configured} onClick={checkCanvas}>
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-800">{v}</span>
    </div>
  );
}
